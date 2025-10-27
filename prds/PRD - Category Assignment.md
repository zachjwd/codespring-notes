---
id: 41de1f25-0d1f-423a-8416-fdfa62acf86a
title: PRD: Category Assignment
projectId: 00fba7e9-d484-42c5-93b0-efd72fd10b08
createdAt: 2025-10-27T00:07:48.900Z
updatedAt: 2025-10-27T00:07:48.900Z
---

## Feature: Category Assignment

### Overview
Attach notes to categories for better organization. Users can select an existing category or create a new one when creating/editing a note. The dashboard can filter notes by category.

### User Stories & Requirements
- As an authenticated user, I want to create categories so that I can organize my notes.
  - Acceptance:
    - I can create a category with a name (required) and optional color.
    - Names are unique per user (case-insensitive).
    - I get a clear error if I try to create a duplicate category.

- As an authenticated user, I want to assign a category to a note so that it’s organized with related notes.
  - Acceptance:
    - In the note form, I can select a category from a dropdown.
    - I can create a new category inline and select it immediately.
    - The selection persists when I save the note.

- As an authenticated user, I want to filter my notes by category on the dashboard so that I can quickly find related notes.
  - Acceptance:
    - I can choose a category filter on the dashboard.
    - The note list updates to only show notes with the selected category.
    - Clearing the filter shows all notes.

- As an authenticated user, I want to manage categories safely so that deleting a category doesn’t lose my notes.
  - Acceptance:
    - Deleting a category either detaches it from notes (sets category to none) or reassigns affected notes to another category.
    - I cannot affect categories or notes that don’t belong to me.

### Technical Implementation

#### Database Schema
Provide the Drizzle ORM schema for categories and the notes foreign key. The project already has a notes table; this feature adds the categories table and a categoryId column to notes.

```typescript
// /db/schema/categories.ts
import { pgTable, uuid, text, timestamp, varchar, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { notes } from './notes'; // existing notes schema

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(), // Clerk user id
    name: text('name').notNull(), // Display name, case-insensitive unique per user
    slug: varchar('slug', { length: 128 }).notNull(), // normalized from name
    color: varchar('color', { length: 16 }).default('gray'), // optional hex or token
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    userSlugUnique: uniqueIndex('categories_user_slug_unique').on(t.userId, t.slug),
  })
);

export const categoriesRelations = relations(categories, ({ many }) => ({
  notes: many(notes),
}));
```

```typescript
// /db/schema/notes.ts (augment existing schema with categoryId)
// Only the relevant additions for this feature are shown
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { categories } from './categories';

export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(), // TipTap JSON or HTML as per existing schema
  // NEW:
  categoryId: uuid('category_id')
    .references(() => categories.id, { onDelete: 'set null', onUpdate: 'cascade' })
    .default(null),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notesRelations = relations(notes, ({ one }) => ({
  // NEW:
  category: one(categories, {
    fields: [notes.categoryId],
    references: [categories.id],
  }),
}));
```

Migration notes:
- Add table categories.
- Add column category_id UUID NULL to notes with FK references categories(id) ON DELETE SET NULL ON UPDATE CASCADE.
- Create unique index categories_user_slug_unique on (user_id, slug).

RLS and tenancy:
- All queries must filter by userId = Clerk user id to enforce data isolation since Drizzle uses the service role connection.
- Do not expose cross-user data.

#### API Endpoints / Server Actions
Use Next.js Server Actions. Ensure each action validates auth via Clerk and inputs via Zod. Revalidate relevant paths/tags after mutations.

```typescript
// /actions/categories.ts
'use server';

import { auth } from '@clerk/nextjs';
import { db } from '@/db';
import { categories, notes } from '@/db/schema';
import { and, eq, ilike } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import slugify from '@sindresorhus/slugify';

const ensureAuth = () => {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  return userId;
};

const nameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(64, 'Name too long')
  .trim();

export async function listCategories() {
  const userId = ensureAuth();
  return db
    .select()
    .from(categories)
    .where(eq(categories.userId, userId))
    .orderBy(categories.name);
}

export async function createCategory(input: { name: string; color?: string }) {
  const userId = ensureAuth();
  const parsedName = nameSchema.parse(input.name);
  const slug = slugify(parsedName, { decamelize: false });

  // enforce uniqueness per user via slug
  const existing = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.slug, slug)))
    .limit(1);

  if (existing.length > 0) {
    throw new Error('A category with this name already exists');
  }

  const [row] = await db
    .insert(categories)
    .values({
      userId,
      name: parsedName,
      slug,
      color: input.color ?? 'gray',
    })
    .returning();

  revalidatePath('/dashboard');
  return row;
}

export async function updateCategory(input: { id: string; name?: string; color?: string }) {
  const userId = ensureAuth();
  const updates: Partial<typeof categories.$inferInsert> = {};
  if (input.name) {
    const parsedName = nameSchema.parse(input.name);
    const slug = slugify(parsedName, { decamelize: false });

    // prevent duplicates
    const dup = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.slug, slug)))
      .limit(1);

    if (dup.length > 0 && dup[0].id !== input.id) {
      throw new Error('A category with this name already exists');
    }
    updates.name = parsedName;
    updates.slug = slug;
  }
  if (input.color) updates.color = input.color;

  const [row] = await db
    .update(categories)
    .set(updates)
    .where(and(eq(categories.id, input.id), eq(categories.userId, userId)))
    .returning();

  if (!row) throw new Error('Category not found');
  revalidatePath('/dashboard');
  return row;
}

export async function deleteCategory(input: { id: string; mode: 'detach' | 'reassign'; newCategoryId?: string }) {
  const userId = ensureAuth();

  if (input.mode === 'reassign') {
    if (!input.newCategoryId) throw new Error('newCategoryId is required for reassign');
    if (input.newCategoryId === input.id) throw new Error('Cannot reassign to the same category');

    // ensure new category belongs to the user
    const target = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, input.newCategoryId), eq(categories.userId, userId)))
      .limit(1);

    if (target.length === 0) throw new Error('Target category not found');
  }

  // verify category belongs to user
  const cat = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, input.id), eq(categories.userId, userId)))
    .limit(1);

  if (cat.length === 0) throw new Error('Category not found');

  // reassign or detach notes first to avoid FK issues
  if (input.mode === 'reassign') {
    await db
      .update(notes)
      .set({ categoryId: input.newCategoryId! })
      .where(and(eq(notes.userId, userId), eq(notes.categoryId, input.id)));
  } else {
    await db
      .update(notes)
      .set({ categoryId: null })
      .where(and(eq(notes.userId, userId), eq(notes.categoryId, input.id)));
  }

  await db.delete(categories).where(and(eq(categories.id, input.id), eq(categories.userId, userId)));

  revalidatePath('/dashboard');
  return { success: true };
}
```

```typescript
// /actions/note-category.ts
'use server';

import { auth } from '@clerk/nextjs';
import { db } from '@/db';
import { categories, notes } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

const ensureAuth = () => {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');
  return userId;
};

export async function assignCategoryToNote(input: { noteId: string; categoryId: string | null }) {
  const userId = ensureAuth();

  // verify note belongs to user
  const note = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.id, input.noteId), eq(notes.userId, userId))).limit(1);
  if (note.length === 0) throw new Error('Note not found');

  if (input.categoryId) {
    // verify category belongs to user
    const cat = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.userId, userId)))
      .limit(1);
    if (cat.length === 0) throw new Error('Category not found');
  }

  await db
    .update(notes)
    .set({ categoryId: input.categoryId })
    .where(and(eq(notes.id, input.noteId), eq(notes.userId, userId)));

  revalidatePath('/dashboard');
  return { success: true };
}

export async function getNotesByCategory(categoryId: string | null) {
  const userId = ensureAuth();
  if (categoryId === null) {
    return db.select().from(notes).where(eq(notes.userId, userId));
  }
  // verify category belongs to user
  const cat = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
    .limit(1);
  if (cat.length === 0) throw new Error('Category not found');

  return db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.categoryId, categoryId)));
}
```

#### Components Structure
Components added or extended for this feature:

```
/components/categories/
├── category-select.tsx          # Dropdown/combobox for note form with create inline
├── category-filter.tsx          # Dashboard filter dropdown
└── category-badge.tsx           # Small badge to display category on note cards

/components/notes/
└── note-form.tsx                # Integrate category-select into existing note form
```

Key components:

- category-select.tsx
  - Props: value (string | null), onChange(id | null), onCreate(name)
  - Fetches categories via server component or client use with a server action RPC pattern.
  - Uses ShadCN Select or Command/Popover pattern to allow “Create new…”.
  - Calls createCategory server action when creating inline, then sets selected value.

- category-filter.tsx
  - Reads/sets search param category via useRouter and useSearchParams.
  - Offers “All” option (null) plus user’s categories.
  - Triggers navigation to /dashboard?category=<id>.

- category-badge.tsx
  - Displays category name and optional color as Tailwind-styled badge.

Example snippets:

```tsx
// /components/categories/category-select.tsx
'use client';
import * as React from 'react';
import { useTransition, useState } from 'react';
import { createCategory, listCategories } from '@/actions/categories';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';

type Props = {
  value: string | null;
  onChange: (val: string | null) => void;
};

export function CategorySelect({ value, onChange }: Props) {
  const [categories, setCategories] = React.useState<Array<{ id: string; name: string }>>([]);
  const [isPending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  React.useEffect(() => {
    startTransition(async () => {
      const list = await listCategories();
      setCategories(list);
    });
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    startTransition(async () => {
      try {
        const cat = await createCategory({ name: newName });
        setCategories((prev) => [...prev, { id: cat.id, name: cat.name }]);
        onChange(cat.id);
        setNewName('');
        setCreating(false);
      } catch (e: any) {
        alert(e.message ?? 'Failed to create category');
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Select value={value ?? ''} onValueChange={(v) => onChange(v || null)} disabled={isPending}>
        <SelectTrigger className="w-[240px]">
          <SelectValue placeholder="No category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem key="none" value="">
            No category
          </SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" size="icon" onClick={() => setCreating(true)} title="Create category">
        <Plus className="h-4 w-4" />
      </Button>
      {creating && (
        <div className="flex gap-2">
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="New category"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button type="button" size="sm" onClick={handleCreate} disabled={isPending}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
```

```tsx
// /components/categories/category-filter.tsx
'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { listCategories } from '@/actions/categories';
import { useEffect, useTransition, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function CategoryFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get('category');
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const list = await listCategories();
      setOptions(list);
    });
  }, []);

  const onChange = (val: string) => {
    const next = new URLSearchParams(params.toString());
    if (!val) next.delete('category');
    else next.set('category', val);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <Select value={selected ?? ''} onValueChange={onChange} disabled={isPending}>
      <SelectTrigger className="w-[220px]">
        <SelectValue placeholder="All categories" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">All</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

Integration into note form:

```tsx
// /components/notes/note-form.tsx (excerpt)
import { CategorySelect } from '@/components/categories/category-select';
import { assignCategoryToNote } from '@/actions/note-category';
// Assume noteId is known when editing; when creating, persist after note creation

// inside component
<CategorySelect
  value={note.categoryId ?? null}
  onChange={async (catId) => {
    if (note.id) {
      await assignCategoryToNote({ noteId: note.id, categoryId: catId });
    } else {
      // if using Zustand for draft before note exists, store locally
      setDraftCategoryId(catId);
    }
  }}
/>
```

Dashboard filtering (server component):

```tsx
// /app/(app)/dashboard/page.tsx (excerpt)
import { db } from '@/db';
import { notes, categories } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { auth } from '@clerk/nextjs';
import { CategoryFilter } from '@/components/categories/category-filter';

export default async function Dashboard({ searchParams }: { searchParams: { category?: string } }) {
  const { userId } = auth();
  if (!userId) return null;
  const categoryId = searchParams.category ?? null;

  const data = categoryId
    ? await db.select().from(notes).where(and(eq(notes.userId, userId), eq(notes.categoryId, categoryId)))
    : await db.select().from(notes).where(eq(notes.userId, userId));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Your Notes</h1>
        <CategoryFilter />
      </div>
      {/* render notes */}
    </div>
  );
}
```

#### State Management
- Note editor state (Zustand) should include draftCategoryId for new notes created client-side before persistence.
- On note save creation, pass draftCategoryId to the server action that creates the note and set the new note’s categoryId.
- For existing notes, assignCategoryToNote server action updates immediately; optionally apply optimistic UI.

Zustand snippet:

```typescript
// /stores/note-editor-store.ts
import { create } from 'zustand';

type NoteEditorState = {
  title: string;
  content: string; // TipTap content string/JSON
  categoryId: string | null;
  setCategoryId: (id: string | null) => void;
  // ...other setters
};

export const useNoteEditorStore = create<NoteEditorState>((set) => ({
  title: '',
  content: '',
  categoryId: null,
  setCategoryId: (id) => set({ categoryId: id }),
}));
```

### Dependencies & Integrations
- Integrations:
  - Notes feature: adds categoryId to notes, supports assignment and filtering.
  - Dashboard view: adds category filter UI and query logic.
  - Auth (Clerk): userId stored in categories.userId and used for tenancy checks.
- External packages:
  - zod (input validation) if not already available
  - @sindresorhus/slugify (for consistent slugs)
- ShadCN UI: Select, Button; optionally Command/Combobox for a richer “create” flow.

Install:
- npm install zod @sindresorhus/slugify

### Implementation Steps
1. Database schema
   - Add /db/schema/categories.ts and define categories table.
   - Update /db/schema/notes.ts to include categoryId FK.
   - Generate and run Drizzle migrations.
2. Queries
   - Ensure indexes are created via uniqueIndex on (userId, slug).
3. Server actions
   - Implement listCategories, createCategory, updateCategory, deleteCategory in /actions/categories.ts.
   - Implement assignCategoryToNote, getNotesByCategory in /actions/note-category.ts.
   - Add auth checks and zod validation.
4. UI components
   - Build CategorySelect, CategoryFilter, and CategoryBadge with ShadCN components.
   - Integrate CategorySelect into note-form.
   - Add CategoryFilter to dashboard toolbar.
5. Frontend-backend integration
   - Wire CategorySelect create/select flows to server actions.
   - Update dashboard page to filter by searchParams.category.
6. Error handling
   - Show inline validation errors and toasts for server errors.
   - Prevent duplicate category names per user.
   - Handle category deletion modes (detach/reassign).
7. Testing
   - Unit tests for server actions.
   - Integration tests for component flows (create/select/filter).
   - UAT on dashboard and note form.

### Edge Cases & Error Handling
- Duplicate category names (case-insensitive): return user-friendly error; prevent creation/update.
- Unauthorized access: throw 401-like errors in server actions when no Clerk user.
- Cross-tenant access: prevent assigning categories/notes not owned by user.
- Deleting a category in use: support detach or reassign; block if invalid newCategoryId or same id.
- Invalid IDs: handle not found with clear messages.
- Long/empty names: enforce with Zod; clamp length to 64 chars.
- Race conditions on create: rely on unique index; catch constraint violation and return conflict error.
- Orphan categories: allowed; categories can exist without notes.
- Network failures or action errors: show toast and keep previous UI state; disable buttons while pending.
- Data freshness: call revalidatePath('/dashboard') after mutations.
