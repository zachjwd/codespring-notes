---
id: b9a708f0-a03e-4296-aa70-0dea51687743
title: PRD: Note Management
projectId: 00fba7e9-d484-42c5-93b0-efd72fd10b08
createdAt: 2025-10-27T00:06:13.680Z
updatedAt: 2025-10-27T00:06:13.680Z
---

## Feature: Note Management

### Overview
Allows authenticated users to create, edit, and delete their notes. Notes are stored per user with timestamps. The UI provides a TipTap-powered editor with a simple form, and a confirmation modal for deletions. This feature underpins the core MVP workflow of writing and maintaining notes.

### User Stories & Requirements
- As an authenticated user, I want to create a new note so that I can capture information.
  - Acceptance:
    - I can open a "New Note" page from the dashboard.
    - I can enter a title (optional) and rich text content (required).
    - On save, the note is persisted and I’m redirected to the dashboard or the note’s page.
    - My note is associated with my user account.
    - Errors are surfaced inline if validation fails.

- As an authenticated user, I want to edit an existing note so that I can update its content.
  - Acceptance:
    - I can open an existing note in edit mode.
    - The form is pre-filled with the note’s current title and content.
    - On save, the changes are persisted, updated_at changes, and I’m shown a success state.
    - If another process has modified the note since I opened it, I see a conflict error and my changes are not silently overwritten (optimistic concurrency).

- As an authenticated user, I want to delete a note so that I can remove outdated content.
  - Acceptance:
    - I can click “Delete” from the note edit view or list.
    - A confirmation modal appears before deletion.
    - On confirm, the note is permanently removed and I see a success toast and am redirected to the dashboard.
    - I cannot delete notes owned by other users.

- As an authenticated user, I want my notes to be visible only to me so that my information remains private.
  - Acceptance:
    - List/fetch/update/delete actions are constrained to the authenticated user.
    - Server actions verify ownership on every mutation.

Non-functional:
- Use server actions for mutations, server components for data fetching where appropriate.
- Robust validation and error handling.
- Production-safe authorization checks using Clerk user ID.
- Smooth, responsive UI leveraging ShadCN and TipTap.

### Technical Implementation

#### Database Schema
```typescript
// /db/schema/notes.ts
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Clerk user id (string), use text for flexibility
  userId: text('user_id').notNull(),

  title: text('title').notNull().default(''),
  // TipTap JSON document
  contentJson: jsonb('content_json').notNull(),
  // Optional plain text excerpt for search/previews
  contentText: text('content_text').notNull().default(''),

  // Optional integration hook for categories (no FK here to keep this feature isolated)
  categoryId: uuid('category_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('notes_user_idx').on(t.userId),
  updatedIdx: index('notes_updated_idx').on(t.updatedAt),
}));
```

Notes:
- Store TipTap content as JSONB; also store a contentText plain-text excerpt for fast previews/search.
- updatedAt is set in code on updates; Postgres does not auto-update timestamps unless you add a trigger (not required for MVP).

#### API Endpoints / Server Actions
```typescript
// /lib/validations/note.ts
import { z } from 'zod';

export const noteContentSchema = z.object({
  title: z.string().max(200).optional().transform((v) => v ?? ''),
  contentJson: z.any(), // TipTap JSON; validated shallowly
  contentText: z.string().max(50000), // safeguard large payloads
});

export const createNoteSchema = noteContentSchema;
export const updateNoteSchema = noteContentSchema.extend({
  id: z.string().uuid(),
  // optimistic concurrency token
  prevUpdatedAt: z.string().datetime(),
});
```

```typescript
// /actions/notes.ts
'use server';

import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db'; // your Drizzle client
import { notes } from '@/db/schema/notes';
import { and, eq, desc } from 'drizzle-orm';
import { createNoteSchema, updateNoteSchema } from '@/lib/validations/note';

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

export async function listNotes() {
  const { userId } = auth();
  if (!userId) throw new Error('UNAUTHORIZED');
  try {
    const rows = await db
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(desc(notes.updatedAt))
      .limit(1000);
    return { data: rows };
  } catch (err) {
    console.error('listNotes:error', err);
    throw new Error('FAILED_TO_LIST_NOTES');
  }
}

export async function getNoteById(id: string) {
  const { userId } = auth();
  if (!userId) throw new Error('UNAUTHORIZED');
  try {
    const [row] = await db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId)));
    if (!row) return { data: null, error: 'NOT_FOUND' as const };
    return { data: row };
  } catch (err) {
    console.error('getNoteById:error', err);
    throw new Error('FAILED_TO_FETCH_NOTE');
  }
}

export async function createNote(input: CreateNoteInput) {
  const { userId } = auth();
  if (!userId) throw new Error('UNAUTHORIZED');

  const parsed = createNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { error: 'VALIDATION_ERROR' as const, details: parsed.error.flatten() };
  }

  try {
    const now = new Date();
    const [row] = await db.insert(notes).values({
      userId,
      title: parsed.data.title ?? '',
      contentJson: parsed.data.contentJson,
      contentText: parsed.data.contentText,
      createdAt: now,
      updatedAt: now,
    }).returning();
    revalidatePath('/dashboard');
    revalidatePath('/notes');
    return { data: row };
  } catch (err) {
    console.error('createNote:error', err);
    return { error: 'FAILED_TO_CREATE' as const };
  }
}

export async function updateNote(input: UpdateNoteInput) {
  const { userId } = auth();
  if (!userId) throw new Error('UNAUTHORIZED');

  const parsed = updateNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { error: 'VALIDATION_ERROR' as const, details: parsed.error.flatten() };
  }

  try {
    const now = new Date();
    // Optimistic concurrency: prevUpdatedAt must match
    const result = await db.update(notes)
      .set({
        title: parsed.data.title ?? '',
        contentJson: parsed.data.contentJson,
        contentText: parsed.data.contentText,
        updatedAt: now,
      })
      .where(and(
        eq(notes.id, parsed.data.id),
        eq(notes.userId, userId),
        // drizzle doesn't do direct datetime equality; compare ISO strings or use SQL`...`
        // simplest: fetch first, check, then update
      ))
      .returning();

    // Fallback approach: Check current updatedAt before updating
    if (result.length === 0) {
      // Try explicit check and conditional update
      const current = await db.query.notes.findFirst({
        where: and(eq(notes.id, parsed.data.id), eq(notes.userId, userId)),
      });
      if (!current) return { error: 'NOT_FOUND' as const };

      if (new Date(parsed.data.prevUpdatedAt).getTime() !== new Date(current.updatedAt).getTime()) {
        return { error: 'CONFLICT' as const };
      }

      const [updated] = await db.update(notes)
        .set({
          title: parsed.data.title ?? '',
          contentJson: parsed.data.contentJson,
          contentText: parsed.data.contentText,
          updatedAt: now,
        })
        .where(and(eq(notes.id, parsed.data.id), eq(notes.userId, userId)))
        .returning();
      revalidatePath('/dashboard');
      revalidatePath(`/notes/${parsed.data.id}`);
      return { data: updated };
    }

    revalidatePath('/dashboard');
    revalidatePath(`/notes/${parsed.data.id}`);
    return { data: result[0] };
  } catch (err) {
    console.error('updateNote:error', err);
    return { error: 'FAILED_TO_UPDATE' as const };
  }
}

export async function deleteNote(id: string) {
  const { userId } = auth();
  if (!userId) throw new Error('UNAUTHORIZED');
  try {
    const [deleted] = await db.delete(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .returning();
    if (!deleted) return { error: 'NOT_FOUND' as const };
    revalidatePath('/dashboard');
    revalidatePath('/notes');
    return { data: true };
  } catch (err) {
    console.error('deleteNote:error', err);
    return { error: 'FAILED_TO_DELETE' as const };
  }
}
```

Notes:
- Use server actions for mutations and server-side listing.
- Keep error payloads simple and typed for UI handling.
- If your Drizzle client uses Supabase service role, RLS is bypassed; ensure ownership checks in where clauses (as shown).

#### Components Structure
```
/components/notes/
├── note-editor.tsx           // TipTap editor component (controlled via props + Zustand)
├── note-form.tsx             // Wraps editor and title input; handles submit via server actions
├── delete-note-dialog.tsx    // ShadCN AlertDialog wrapper for confirming deletions
├── note-actions.tsx          // Edit/Delete buttons and related UI
└── note-save-bar.tsx         // Sticky save/cancel bar with dirty state
```

Pages (App Router):
```
/app/(dashboard)/notes/new/page.tsx
/app/(dashboard)/notes/[id]/edit/page.tsx
```

Example component outlines:

```tsx
// /components/notes/note-editor.tsx
'use client';

import { useEffect } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { noteEditorStore } from '@/stores/noteEditor';

type Props = {
  initialContent?: any;
  onUpdate?: (contentJson: any, contentText: string) => void;
};

export function NoteEditor({ initialContent, onUpdate }: Props) {
  const setDirty = noteEditorStore((s) => s.setDirty);

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialContent ?? { type: 'doc', content: [] },
    onUpdate: ({ editor }) => {
      const json = editor.getJSON();
      const text = editor.getText();
      setDirty(true);
      onUpdate?.(json, text);
    },
  });

  useEffect(() => () => editor?.destroy(), [editor]);

  return <EditorContent editor={editor} className="prose max-w-none min-h-[300px]" />;
}
```

```tsx
// /components/notes/note-form.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input, Button } from '@/components/ui';
import { NoteEditor } from './note-editor';
import { createNote, updateNote } from '@/actions/notes';
import { noteEditorStore } from '@/stores/noteEditor';

type Props = {
  mode: 'create' | 'edit';
  initial?: {
    id: string;
    title: string;
    contentJson: any;
    contentText: string;
    updatedAt: string;
  };
};

export function NoteForm({ mode, initial }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [contentJson, setContentJson] = useState<any>(initial?.contentJson ?? null);
  const [contentText, setContentText] = useState<string>(initial?.contentText ?? '');
  const [submitting, setSubmitting] = useState(false);
  const setDirty = noteEditorStore((s) => s.setDirty);

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      if (mode === 'create') {
        const res = await createNote({ title, contentJson, contentText });
        if ('error' in res && res.error) {
          // TODO: show toast
          setSubmitting(false);
          return;
        }
        router.push('/dashboard');
      } else {
        const res = await updateNote({
          id: initial!.id,
          title,
          contentJson,
          contentText,
          prevUpdatedAt: initial!.updatedAt,
        });
        if ('error' in res && res.error) {
          // handle NOT_FOUND / CONFLICT / VALIDATION_ERROR
          setSubmitting(false);
          return;
        }
        router.refresh();
      }
      setDirty(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Input
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <NoteEditor
        initialContent={initial?.contentJson}
        onUpdate={(json, text) => {
          setContentJson(json);
          setContentText(text);
        }}
      />
      <div className="flex gap-2">
        <Button onClick={onSubmit} disabled={submitting || !contentText.trim()}>
          {mode === 'create' ? 'Create Note' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}
```

```tsx
// /components/notes/delete-note-dialog.tsx
'use client';

import { useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { deleteNote } from '@/actions/notes';
import { useRouter } from 'next/navigation';

export function DeleteNoteDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (v: boolean) => void; }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const onConfirm = async () => {
    setLoading(true);
    const res = await deleteNote(id);
    setLoading(false);
    if ('error' in res && res.error) {
      // show toast
      return;
    }
    onOpenChange(false);
    router.push('/dashboard');
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <p>Are you sure you want to delete this note? This action cannot be undone.</p>
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={loading}>Delete</AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

Pages:
```tsx
// /app/(dashboard)/notes/new/page.tsx
import { auth } from '@clerk/nextjs/server';
import { NoteForm } from '@/components/notes/note-form';

export default function NewNotePage() {
  const { userId } = auth();
  if (!userId) return null; // CodeSpring boilerplate should redirect unauthenticated

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">New Note</h1>
      <NoteForm mode="create" />
    </div>
  );
}
```

```tsx
// /app/(dashboard)/notes/[id]/edit/page.tsx
import { auth } from '@clerk/nextjs/server';
import { getNoteById } from '@/actions/notes';
import { NoteForm } from '@/components/notes/note-form';
import { notFound } from 'next/navigation';

type Props = { params: { id: string } };

export default async function EditNotePage({ params }: Props) {
  const { userId } = auth();
  if (!userId) return null;
  const res = await getNoteById(params.id);
  if (!res.data) notFound();

  const n = res.data!;
  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Edit Note</h1>
      </div>
      <div className="mt-4">
        <NoteForm
          mode="edit"
          initial={{
            id: n.id,
            title: n.title,
            contentJson: n.contentJson,
            contentText: n.contentText,
            updatedAt: n.updatedAt?.toISOString?.() ?? new Date(n.updatedAt as any).toISOString(),
          }}
        />
      </div>
    </div>
  );
}
```

#### State Management
- Local UI state: React useState within NoteForm.
- Editor state: Zustand store for dirty tracking and cross-component coordination.
- Server state: Fetched in server components via server actions (getNoteById, listNotes). Mutations via server actions; revalidate paths after mutations.

Zustand store:
```ts
// /stores/noteEditor.ts
'use client';
import { create } from 'zustand';

type State = { isDirty: boolean };
type Actions = { setDirty: (v: boolean) => void; reset: () => void; };

export const noteEditorStore = create<State & Actions>((set) => ({
  isDirty: false,
  setDirty: (v) => set({ isDirty: v }),
  reset: () => set({ isDirty: false }),
}));
```

### Dependencies & Integrations
- Clerk.dev: Used to identify userId in server actions.
- Supabase + Drizzle: Persistence. Using service role on server; enforce authorization in application code.
- ShadCN UI: Input, Button, AlertDialog components.
- TipTap: @tiptap/react and @tiptap/starter-kit for the editor.
- Framer Motion: Optional for subtle transitions in forms/modals (not required for MVP).
- Integration points:
  - Dashboard View: listNotes will feed the dashboard list.
  - Category Assignment (future/other feature): notes table includes nullable categoryId; UI does not expose category selection in this feature.

Additional packages (if not already present):
- zod: input validation.
- @tiptap/react, @tiptap/starter-kit.

### Implementation Steps
1. Create database schema
   - Add /db/schema/notes.ts as above.
   - Run Drizzle migration to create the notes table and indexes.

2. Generate queries
   - Ensure db.query.notes is available (Drizzle typed query API).

3. Implement server actions
   - Add /actions/notes.ts with listNotes, getNoteById, createNote, updateNote, deleteNote.
   - Use Clerk auth() inside each action.
   - Ensure revalidatePath for '/dashboard' and '/notes'.

4. Build UI components
   - Implement NoteEditor, NoteForm, DeleteNoteDialog, NoteActions, NoteSaveBar using ShadCN + TipTap.
   - Wire validation errors and loading states.

5. Connect frontend to backend
   - New Note page uses NoteForm(mode='create').
   - Edit Note page fetches data server-side and renders NoteForm(mode='edit').
   - Dashboard integrates listNotes for displaying user notes (outside scope, but ensure action is available).

6. Add error handling
   - Return typed errors from actions: VALIDATION_ERROR, NOT_FOUND, CONFLICT, FAILED_TO_CREATE/UPDATE/DELETE.
   - Show toasts/snackbars for user feedback; disable submit when invalid.

7. Test the feature
   - Unit tests for server actions with mocked auth and db.
   - Integration tests for UI flows using Playwright.
   - Manual UAT: creation, editing with concurrency, deletion confirmation.

Optional (if using Supabase RLS instead of service role):
- Configure RLS policies to enforce user ownership by comparing notes.user_id to a JWT claim set by the backend. With Clerk, this requires JWT sync or PGVARS; otherwise rely on application-level checks as implemented.

### Edge Cases & Error Handling
- Unauthorized access: If auth().userId is absent, throw UNAUTHORIZED; CodeSpring router should handle redirects.
- Empty content: Prevent saving when contentText is empty/whitespace; disable save button and show inline helper.
- Oversized content: Enforce contentText <= 50k chars; return VALIDATION_ERROR with details.
- Concurrency: If updatedAt changed since form load, return CONFLICT; UI should prompt user to refresh or merge.
- Deleting non-existent or non-owned note: Return NOT_FOUND; show toast and redirect to dashboard.
- Network/server failure: Show generic error toast and allow retry.
- XSS concerns: Store JSON only; when rendering HTML elsewhere, sanitize or rely on TipTap-rendered content.
- Rapid double-submit: Disable submit while pending to avoid duplicate creates.
- Invalid UUID param: getNoteById gracefully returns NOT_FOUND.

### Testing Approach
- Unit tests:
  - createNote: success, validation error, unauthorized.
  - updateNote: success, not found, conflict, validation error.
  - deleteNote: success, not found, unauthorized.
  - listNotes/getNoteById: success, unauthorized.
- Integration tests (Playwright):
  - Create flow: open New Note, type, save, see in dashboard list.
  - Edit flow: open existing note, change content, save, success indication.
  - Conflict: open same note in two windows; save from window A, attempt save from window B -> shows conflict.
  - Delete flow: open edit, trigger delete, confirm modal, note disappears from list.
- User acceptance tests:
  - Keyboard-only usage works (focus, submit).
  - Error messages are clear and actionable.
  - Redirects after actions go to expected pages.
  - Auth boundaries: user A cannot access user B’s note via URL.

Notes for production readiness:
- Add metrics/logging around create/update/delete actions.
- Consider rate limiting if abuse is a concern.
- Consider adding a Postgres trigger to auto-update updated_at if desired later.
