---
id: 4582b4de-4d2f-45aa-b2b7-61c747ee5ae9
title: PRD: Rich Text Editor
projectId: 00fba7e9-d484-42c5-93b0-efd72fd10b08
createdAt: 2025-10-27T00:09:13.824Z
updatedAt: 2025-10-27T00:09:13.824Z
---

## Feature: Rich Text Editor

### Overview
A TipTap-powered rich text editor that lets users create and edit notes with formatting (bold, italic, headings, lists, blockquote, code block, links, underline). Content is stored as TipTap JSON and sanitized HTML in Postgres via Drizzle. The editor provides a toolbar for formatting and preserves formatting when reopening notes.

### User Stories & Requirements
- As an authenticated user, I want to format text (bold, italic, underline, headings) so that my notes are more readable.
  - Acceptance criteria:
    - Toolbar exposes bold, italic, underline, headings (H1–H3).
    - Keyboard shortcuts (Cmd/Ctrl+B/I/U) toggle formatting.
    - State reflects active formatting in toolbar.

- As an authenticated user, I want to create lists, blockquotes, and code blocks so that I can structure my notes.
  - Acceptance criteria:
    - Toolbar exposes bullet list, ordered list, blockquote, and code block.
    - Toggling works on selections and at cursor.
    - Undo/redo supported.

- As an authenticated user, I want to save formatted content so that formatting persists.
  - Acceptance criteria:
    - Save action persists JSON and sanitized HTML to the database.
    - Re-opening a note loads the saved formatting correctly.
    - Unauthorized users cannot edit another user’s notes.

- As an authenticated user, I want to paste formatted content safely so that my notes are secure.
  - Acceptance criteria:
    - Pasted content is sanitized (scripts/events removed).
    - Saved HTML is sanitized server-side as well.
    - Rendering is safe from XSS.

- As an authenticated user, I want to be warned of conflicts if another session updated the note.
  - Acceptance criteria:
    - If updated_at changed since last load, saving returns a conflict error.
    - UI can prompt the user to reload.

### Technical Implementation

#### Database Schema
Provide or update the notes table to include rich text fields. If a notes table already exists, add the content fields via migration; otherwise use the schema below.

```typescript
// /db/schema/notes.ts
import { pgTable, uuid, varchar, jsonb, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: varchar('user_id', { length: 256 }).notNull(),
  title: varchar('title', { length: 256 }).notNull().default('Untitled'),
  // TipTap JSON document
  contentJson: jsonb('content_json').$type<unknown>().notNull().default(sql`'{\"type\":\"doc\",\"content\":[]}'::jsonb`),
  // Sanitized HTML snapshot for fast read-only rendering/search
  contentHtml: text('content_html').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('notes_user_idx').on(table.userId),
}));
```

Notes:
- Store both contentJson (source of truth) and contentHtml (sanitized, denormalized for fast render).
- Use updatedAt for optimistic concurrency control.

#### API Endpoints / Server Actions

```typescript
// /lib/validators/note.ts
import { z } from 'zod';

export const SaveNoteContentSchema = z.object({
  id: z.string().uuid(),
  contentJson: z.unknown(), // TipTap JSON (validated by TipTap runtime)
  contentHtml: z.string().max(750_000), // practical upper bound
  lastKnownUpdatedAt: z.string().datetime().optional(),
});
export type SaveNoteContentInput = z.infer<typeof SaveNoteContentSchema>;
```

```typescript
// /actions/notes-actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@clerk/nextjs';
import DOMPurify from 'isomorphic-dompurify';
import { db } from '@/db';
import { notes } from '@/db/schema/notes';
import { eq, and } from 'drizzle-orm';
import { SaveNoteContentSchema, SaveNoteContentInput } from '@/lib/validators/note';

export async function getNoteById(noteId: string) {
  const { userId } = auth();
  if (!userId) {
    throw new Error('Unauthorized');
  }

  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);

  if (!note) {
    throw new Error('Not found');
  }

  return note;
}

export async function updateNoteContent(input: SaveNoteContentInput) {
  const { userId } = auth();
  if (!userId) {
    throw new Error('Unauthorized');
  }

  const parsed = SaveNoteContentSchema.parse(input);

  // Retrieve current record and verify ownership
  const [existing] = await db
    .select({
      id: notes.id,
      userId: notes.userId,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(and(eq(notes.id, parsed.id), eq(notes.userId, userId)))
    .limit(1);

  if (!existing) {
    throw new Error('Not found');
  }

  // Optimistic concurrency check
  if (parsed.lastKnownUpdatedAt) {
    const clientTs = new Date(parsed.lastKnownUpdatedAt).getTime();
    const serverTs = new Date(existing.updatedAt).getTime();
    if (serverTs > clientTs) {
      throw new Error('Conflict'); // Handle on client: prompt to reload
    }
  }

  // Sanitize HTML on server
  const sanitizedHtml = DOMPurify.sanitize(parsed.contentHtml, {
    USE_PROFILES: { html: true },
  });

  const [updated] = await db
    .update(notes)
    .set({
      contentJson: parsed.contentJson,
      contentHtml: sanitizedHtml,
      updatedAt: new Date(),
    })
    .where(and(eq(notes.id, parsed.id), eq(notes.userId, userId)))
    .returning();

  // Revalidate note routes if any
  revalidatePath(`/notes/${parsed.id}`);
  revalidatePath('/');

  return updated;
}
```

#### Components Structure

```
/components/rich-text-editor/
├── note-editor.tsx          // Client: wraps TipTap editor + toolbar + save
├── toolbar.tsx              // Client: formatting controls (ShadCN UI)
├── viewer.tsx               // Client: read-only renderer from sanitized HTML
└── shortcuts.ts             // Client: registers Cmd/Ctrl+S and helpers
/state/
└── editor-store.ts          // Client: Zustand store for dirty state, saving status
```

Example page usage:

```tsx
// /app/(dashboard)/notes/[id]/page.tsx
import { getNoteById } from '@/actions/notes-actions';
import NoteEditor from '@/components/rich-text-editor/note-editor';

export default async function NotePage({ params }: { params: { id: string } }) {
  const note = await getNoteById(params.id);

  return (
    <div className="p-4">
      <h1 className="mb-4 text-2xl font-semibold">{note.title}</h1>
      <NoteEditor
        noteId={note.id}
        initialJson={note.contentJson}
        initialHtml={note.contentHtml}
        lastKnownUpdatedAt={note.updatedAt?.toISOString()}
      />
    </div>
  );
}
```

Key components:

```tsx
// /components/rich-text-editor/note-editor.tsx
'use client';

import { useEffect, useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useEditorStore } from '@/state/editor-store';
import Toolbar from './toolbar';
import { updateNoteContent } from '@/actions/notes-actions';
import DOMPurify from 'isomorphic-dompurify';
import { toast } from 'sonner';

type Props = {
  noteId: string;
  initialJson: unknown;
  initialHtml: string;
  lastKnownUpdatedAt?: string;
};

export default function NoteEditor(props: Props) {
  const { setDirty, setSaving, saving } = useEditorStore();

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: 'Start typing your note...' }),
    ],
    content: props.initialJson,
    editorProps: {
      handlePaste(view, event, slice) {
        const html = event.clipboardData?.getData('text/html');
        if (html) {
          event.preventDefault();
          const cleaned = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
          view.dispatch(view.state.tr.insertText(''));
          editor?.commands.insertContent(cleaned);
          return true;
        }
        return false;
      },
      attributes: {
        class:
          'prose dark:prose-invert max-w-none focus:outline-none min-h-[300px] p-3',
      },
    },
    onUpdate: () => {
      setDirty(true);
    },
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);

  const handleSave = async () => {
    if (!editor) return;
    try {
      setSaving(true);
      const json = editor.getJSON();
      const html = editor.getHTML();
      await updateNoteContent({
        id: props.noteId,
        contentJson: json,
        contentHtml: html,
        lastKnownUpdatedAt: props.lastKnownUpdatedAt,
      });
      setDirty(false);
      toast.success('Saved');
    } catch (err: any) {
      if (err?.message === 'Conflict') {
        toast.error('This note was updated elsewhere. Please reload.');
      } else if (err?.message === 'Unauthorized') {
        toast.error('You are not authorized to edit this note.');
      } else {
        toast.error('Failed to save');
      }
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (!editor) return null;

  return (
    <div className="border rounded-md">
      <Toolbar editor={editor} onSave={handleSave} saving={saving} />
      <EditorContent editor={editor} />
    </div>
  );
}
```

```tsx
// /components/rich-text-editor/toolbar.tsx
'use client';

import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Separator } from '@/components/ui/separator';
import { useEditorStore } from '@/state/editor-store';

export default function Toolbar({
  editor,
  onSave,
  saving,
}: {
  editor: Editor;
  onSave: () => void;
  saving: boolean;
}) {
  if (!editor) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 p-2 border-b bg-muted/30">
      <Toggle
        pressed={editor.isActive('bold')}
        onPressedChange={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </Toggle>
      <Toggle
        pressed={editor.isActive('italic')}
        onPressedChange={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </Toggle>
      <Toggle
        pressed={editor.isActive('underline')}
        onPressedChange={() => editor.chain().focus().toggleUnderline().run()}
      >
        U
      </Toggle>
      <Separator orientation="vertical" className="mx-1 h-6" />
      <Button
        variant={editor.isActive('heading', { level: 1 }) ? 'default' : 'ghost'}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </Button>
      <Button
        variant={editor.isActive('heading', { level: 2 }) ? 'default' : 'ghost'}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </Button>
      <Button
        variant={editor.isActive('heading', { level: 3 }) ? 'default' : 'ghost'}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </Button>
      <Separator orientation="vertical" className="mx-1 h-6" />
      <Button
        variant={editor.isActive('bulletList') ? 'default' : 'ghost'}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        • List
      </Button>
      <Button
        variant={editor.isActive('orderedList') ? 'default' : 'ghost'}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1. List
      </Button>
      <Button
        variant={editor.isActive('blockquote') ? 'default' : 'ghost'}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </Button>
      <Button
        variant={editor.isActive('codeBlock') ? 'default' : 'ghost'}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        </>
      </Button>
      <Separator orientation="vertical" className="mx-1 h-6" />
      <Button
        variant="ghost"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      >
        Undo
      </Button>
      <Button
        variant="ghost"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      >
        Redo
      </Button>
      <div className="ml-auto">
        <Button onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
```

```tsx
// /components/rich-text-editor/viewer.tsx
'use client';

import DOMPurify from 'isomorphic-dompurify';

export default function Viewer({ html }: { html: string }) {
  const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  return (
    <div
      className="prose dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
```

```typescript
// /state/editor-store.ts
import { create } from 'zustand';

type EditorState = {
  dirty: boolean;
  saving: boolean;
  setDirty: (v: boolean) => void;
  setSaving: (v: boolean) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  dirty: false,
  saving: false,
  setDirty: (dirty) => set({ dirty }),
  setSaving: (saving) => set({ saving }),
}));
```

### Dependencies & Integrations
- TipTap: @tiptap/react, @tiptap/starter-kit, @tiptap/extension-underline, @tiptap/extension-link, @tiptap/extension-placeholder.
- Zustand: editor UI state.
- isomorphic-dompurify: sanitize pasted and stored HTML.
- ShadCN UI: Buttons, Toggle, Separator. Ensure the UI components exist or scaffold via shadcn/ui CLI.
- Clerk.dev: Server action authorization (auth()).
- Drizzle ORM + Supabase: Persist note content.
- Framer Motion: Not required for MVP of editor.
- Whop: Not used in this feature.

Install:
- npm i @tiptap/react @tiptap/starter-kit @tiptap/extension-underline @tiptap/extension-link @tiptap/extension-placeholder isomorphic-dompurify zustand zod

### Implementation Steps
1. Create database schema
   - Add/confirm /db/schema/notes.ts as above (or migration to add contentJson/contentHtml if table exists).
   - Run Drizzle migration to apply changes.

2. Generate queries
   - Ensure Drizzle db instance is configured (CodeSpring boilerplate).
   - Verify indexes on user_id for performance.

3. Implement server actions
   - Add /lib/validators/note.ts with zod schema.
   - Add /actions/notes-actions.ts with getNoteById and updateNoteContent.
   - Add HTML sanitization using isomorphic-dompurify.
   - Handle errors for Unauthorized, Not found, Conflict.

4. Build UI components
   - Implement /components/rich-text-editor/note-editor.tsx with TipTap and toolbar.
   - Implement /components/rich-text-editor/toolbar.tsx using ShadCN UI.
   - Implement /components/rich-text-editor/viewer.tsx for read-only.

5. Connect frontend to backend
   - In /app/(dashboard)/notes/[id]/page.tsx, load note via server action and render NoteEditor with initial content and lastKnownUpdatedAt.
   - Wire Save button and Cmd/Ctrl+S to updateNoteContent.

6. Add error handling
   - Toasts for success, conflict, unauthorized, generic errors.
   - Console.error on unexpected failures for observability (hook into any existing logging/Sentry if present).
   - Disable Save while saving; show status.

7. Test the feature
   - Manual pass: format, save, reload, verify persistence and sanitization.
   - Add unit/integration/e2e tests as below.

### Edge Cases & Error Handling
- Unauthorized access: auth() missing userId -> throw 'Unauthorized'.
- Note not found or not owned: throw 'Not found'.
- Concurrency conflict: lastKnownUpdatedAt older than DB updatedAt -> throw 'Conflict'; UI prompts reload.
- Large content: HTML length validation; return error if exceeds bound; consider chunking or increasing limit if needed.
- XSS via paste/import: sanitize HTML on paste and on server before saving; sanitize again on render.
- Malformed JSON content: TipTap controls JSON; if contentJson is unexpected, fallback to empty document.
- Network failures during save: disable Save while saving; show retry option.
- Unsupported formatting in toolbar: disable or hide buttons based on editor.can().

### Testing Approach
- Unit tests
  - /actions/notes-actions.test.ts:
    - updateNoteContent rejects Unauthorized.
    - updateNoteContent rejects Not found (different user).
    - updateNoteContent detects Conflict with stale lastKnownUpdatedAt.
    - updateNoteContent sanitizes HTML (e.g., strips <script> tags, onClick handlers).
    - getNoteById returns note for owner; rejects otherwise.
  - /lib/validators/note.test.ts:
    - Validate constraints for contentHtml size and id format.

- Integration tests
  - Render NoteEditor, simulate typing and formatting, trigger save, assert server action called with JSON and HTML.
  - Simulate conflict by changing updatedAt in DB between loads; expect conflict toast.

- E2E tests (Playwright)
  - Authenticated user can open a note, apply bold/italic/heading, save, reload, and see formatting preserved.
  - Pasting HTML with script tags results in sanitized content (no script nodes in DOM).
  - Shortcut Cmd/Ctrl+S triggers save.
  - Unauthorized user cannot access another user's note (redirect/404/Not found).

- User acceptance tests
  - Toolbar reflects active styles when cursor moves across formatted text.
  - Undo/redo works for formatting and content edits.
  - Lists and headings toggle appropriately.
