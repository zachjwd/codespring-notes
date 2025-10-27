---
id: eeda4284-a80f-4efc-8485-745f78610552
title: PRD: Dashboard View
projectId: 00fba7e9-d484-42c5-93b0-efd72fd10b08
createdAt: 2025-10-27T00:02:06.976Z
updatedAt: 2025-10-27T00:02:06.976Z
---

## Feature: Dashboard View

### Overview
The Dashboard provides a single, fast view where authenticated users see all of their notes with basic organization controls. Users can:
- View notes list (title, category, updated date, pinned state)
- Filter by category
- Search by title
- Sort and paginate results
This is the default landing page post-authentication and serves as the central navigation hub.

### User Stories & Requirements
- As an authenticated user, I want to see a list of my notes so that I can quickly access them.
  - Acceptance:
    - Only my notes are shown (scoped by Clerk userId)
    - Notes show title, category label (if any), updated time, and pin indicator
    - Default sorted by last updated desc
- As a user, I want to filter notes by category so that I can focus on a subset of notes.
  - Acceptance:
    - Category dropdown lists my categories
    - Selecting a category filters the notes immediately
    - "All" shows all categories
- As a user, I want to search notes by title so that I can quickly find a note.
  - Acceptance:
    - Search input filters notes by title (case-insensitive substring)
    - Works together with category filter
- As a user, I want to sort notes so that I can view them in my preferred order.
  - Acceptance:
    - Sort options: Updated (newest), Updated (oldest), Created (newest), Title (A-Z)
- As a user, I want pagination so that the dashboard remains fast for large note sets.
  - Acceptance:
    - Default page size 20
    - Next/Previous page controls
    - Total count displayed
- As a user, I want fast loading and graceful empty states so that the page is usable at all times.
  - Acceptance:
    - Empty state message when there are no notes
    - Loading skeletons while data is being prepared during client transitions

### Technical Implementation

#### Database Schema
```typescript
// /db/schema/notes.ts
import {
  pgTable, uuid, text, boolean, timestamp, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(), // Clerk user id
    name: text('name').notNull(),
    color: text('color'), // optional hex or token
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxUser: index('idx_categories_user').on(t.userId),
    uqUserName: uniqueIndex('uq_categories_user_name').on(t.userId, t.name),
  })
);

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(), // Clerk user id
    title: text('title').notNull().default('Untitled'),
    content: jsonb('content').notNull().default({}), // TipTap JSON (not used on dashboard)
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    isArchived: boolean('is_archived').notNull().default(false),
    isPinned: boolean('is_pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxUserUpdated: index('idx_notes_user_updated').on(t.userId, t.updatedAt),
    idxUserCategory: index('idx_notes_user_category').on(t.userId, t.categoryId),
    idxUserTitle: index('idx_notes_user_title').on(t.userId, t.title),
  })
);

export const categoriesRelations = relations(categories, ({ many }) => ({
  notes: many(notes),
}));

export const notesRelations = relations(notes, ({ one }) => ({
  category: one(categories, {
    fields: [notes.categoryId],
    references: [categories.id],
  }),
}));
```

#### API Endpoints / Server Actions
Prefer server actions and server components over API routes for SSR and secure data access. All actions must enforce per-user scoping via Clerk.

```typescript
// /actions/dashboard-actions.ts
'use server';

import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { notes, categories } from '@/db/schema/notes';
import { and, eq, desc, asc, ilike, isNull, sql, count } from 'drizzle-orm';
import { z } from 'zod';

export const dashboardQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  categoryId: z.string().uuid().optional(), // if missing or invalid, treated as "all"
  sort: z
    .enum(['updated_desc', 'updated_asc', 'created_desc', 'title_asc'])
    .default('updated_desc')
    .optional(),
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  includeArchived: z.coerce.boolean().default(false).optional(),
  pinnedFirst: z.coerce.boolean().default(true).optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export type DashboardNote = {
  id: string;
  title: string;
  isPinned: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  category?: { id: string; name: string; color: string | null } | null;
};

export async function listCategoriesForUser() {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  try {
    const rows = await db
      .select({
        id: categories.id,
        name: categories.name,
        color: categories.color,
      })
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.name));

    return rows;
  } catch (err) {
    console.error('listCategoriesForUser error', err);
    throw new Error('Failed to load categories');
  }
}

export async function listNotesForDashboard(input: DashboardQuery) {
  const { userId } = auth();
  if (!userId) throw new Error('Unauthorized');

  const params = dashboardQuerySchema.parse(input);
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;

  const where = and(
    eq(notes.userId, userId),
    params.includeArchived ? undefined : eq(notes.isArchived, false),
    params.categoryId ? eq(notes.categoryId, params.categoryId) : undefined,
    params.search ? ilike(notes.title, `%${params.search}%`) : undefined
  );

  const orderExpressions: any[] = [];
  if (params.pinnedFirst) {
    // Pinned first, then desired sort
    orderExpressions.push(desc(notes.isPinned));
  }
  switch (params.sort ?? 'updated_desc') {
    case 'updated_desc':
      orderExpressions.push(desc(notes.updatedAt));
      break;
    case 'updated_asc':
      orderExpressions.push(asc(notes.updatedAt));
      break;
    case 'created_desc':
      orderExpressions.push(desc(notes.createdAt));
      break;
    case 'title_asc':
      orderExpressions.push(asc(notes.title));
      break;
  }

  try {
    const [{ total }] = await db
      .select({ total: count() })
      .from(notes)
      .where(where);

    const rows = await db
      .select({
        id: notes.id,
        title: notes.title,
        isPinned: notes.isPinned,
        isArchived: notes.isArchived,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        categoryId: notes.categoryId,
        categoryName: categories.name,
        categoryColor: categories.color,
      })
      .from(notes)
      .leftJoin(categories, eq(categories.id, notes.categoryId))
      .where(where)
      .orderBy(...orderExpressions)
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const items: DashboardNote[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      isPinned: r.isPinned,
      isArchived: r.isArchived,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      category: r.categoryId
        ? { id: r.categoryId, name: r.categoryName ?? '', color: r.categoryColor ?? null }
        : null,
    }));

    return {
      items,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (err) {
    console.error('listNotesForDashboard error', err);
    throw new Error('Failed to load notes');
  }
}
```

#### Components Structure
```
/app/(app)/dashboard/
├── page.tsx                  // Server component entry
├── dashboard-client.tsx      // Client wrapper for animations & transitions
/components/dashboard/
├── filters.tsx               // Client: search, category, sort, archived toggle
├── notes-grid.tsx            // Client: animated grid list
├── note-card.tsx             // Presentational card for a note
└── pagination.tsx            // Client: pager controls
/components/common/
└── empty-state.tsx           // Simple empty state component
```

Example key files:

```typescript
// /app/(app)/dashboard/page.tsx
import { listNotesForDashboard, listCategoriesForUser } from '@/actions/dashboard-actions';
import DashboardClient from './dashboard-client';

export const dynamic = 'force-dynamic';

type PageProps = {
  searchParams: {
    search?: string;
    categoryId?: string;
    sort?: 'updated_desc' | 'updated_asc' | 'created_desc' | 'title_asc';
    page?: string;
    pageSize?: string;
    includeArchived?: 'true' | 'false';
  };
};

export default async function DashboardPage({ searchParams }: PageProps) {
  const query = {
    search: searchParams.search,
    categoryId: searchParams.categoryId,
    sort: searchParams.sort,
    page: Number(searchParams.page ?? 1),
    pageSize: Number(searchParams.pageSize ?? 20),
    includeArchived: searchParams.includeArchived === 'true',
  };

  const [categories, notesRes] = await Promise.all([
    listCategoriesForUser(),
    listNotesForDashboard(query),
  ]);

  return (
    <DashboardClient
      categories={categories}
      data={notesRes}
      query={query}
    />
  );
}
```

```typescript
// /app/(app)/dashboard/dashboard-client.tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Filters } from '@/components/dashboard/filters';
import { NotesGrid } from '@/components/dashboard/notes-grid';
import { Pagination } from '@/components/dashboard/pagination';
import EmptyState from '@/components/common/empty-state';

type DashboardClientProps = {
  categories: { id: string; name: string; color: string | null }[];
  data: {
    items: {
      id: string;
      title: string;
      isPinned: boolean;
      isArchived: boolean;
      createdAt: string;
      updatedAt: string;
      category?: { id: string; name: string; color: string | null } | null;
    }[];
    pagination: { total: number; page: number; pageSize: number; totalPages: number };
  };
  query: any;
};

export default function DashboardClient({ categories, data, query }: DashboardClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const onChangeParams = (params: Record<string, string | undefined>) => {
    const sp = new URLSearchParams(searchParams.toString());
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    });
    sp.set('page', '1'); // reset page on filter change
    router.push(`/dashboard?${sp.toString()}`);
  };

  return (
    <div className="mx-auto max-w-6xl p-4 space-y-4">
      <Filters categories={categories} value={query} onChange={onChangeParams} />
      {data.items.length === 0 ? (
        <EmptyState title="No notes found" description="Try creating a note or adjusting filters." />
      ) : (
        <>
          <NotesGrid items={data.items} />
          <Pagination
            page={data.pagination.page}
            totalPages={data.pagination.totalPages}
            onPageChange={(p) => onChangeParams({ page: String(p) })}
          />
        </>
      )}
    </div>
  );
}
```

```typescript
// /components/dashboard/filters.tsx
'use client';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type FiltersProps = {
  categories: { id: string; name: string; color: string | null }[];
  value: {
    search?: string;
    categoryId?: string;
    sort?: string;
    includeArchived?: boolean;
  };
  onChange: (p: Record<string, string | undefined>) => void;
};

export function Filters({ categories, value, onChange }: FiltersProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
      <div className="md:col-span-2">
        <Label htmlFor="search">Search</Label>
        <Input
          id="search"
          placeholder="Search by title..."
          defaultValue={value.search ?? ''}
          onChange={(e) => onChange({ search: e.target.value })}
        />
      </div>

      <div>
        <Label>Category</Label>
        <Select
          defaultValue={value.categoryId ?? 'all'}
          onValueChange={(v) => onChange({ categoryId: v === 'all' ? undefined : v })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex gap-2">
        <div className="w-full">
          <Label>Sort</Label>
          <Select
            defaultValue={value.sort ?? 'updated_desc'}
            onValueChange={(v) => onChange({ sort: v })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="updated_desc">Updated (newest)</SelectItem>
              <SelectItem value="updated_asc">Updated (oldest)</SelectItem>
              <SelectItem value="created_desc">Created (newest)</SelectItem>
              <SelectItem value="title_asc">Title (A-Z)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pt-6">
          <Switch
            checked={Boolean(value.includeArchived)}
            onCheckedChange={(checked) => onChange({ includeArchived: checked ? 'true' : undefined })}
            id="archived"
          />
          <Label htmlFor="archived">Archived</Label>
        </div>
      </div>
    </div>
  );
}
```

```typescript
// /components/dashboard/notes-grid.tsx
'use client';

import { motion, AnimatePresence } from 'framer-motion';
import NoteCard from './note-card';

type NotesGridProps = {
  items: {
    id: string;
    title: string;
    isPinned: boolean;
    isArchived: boolean;
    updatedAt: string;
    category?: { id: string; name: string; color: string | null } | null;
  }[];
};

export function NotesGrid({ items }: NotesGridProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <AnimatePresence initial={false}>
        {items.map((n) => (
          <motion.div
            key={n.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.15 }}
          >
            <NoteCard note={n} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
```

```typescript
// /components/dashboard/note-card.tsx
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Pin } from 'lucide-react';
import { cn } from '@/lib/utils';

type NoteCardProps = {
  note: {
    id: string;
    title: string;
    isPinned: boolean;
    isArchived: boolean;
    updatedAt: string;
    category?: { id: string; name: string; color: string | null } | null;
  };
};

export default function NoteCard({ note }: NoteCardProps) {
  return (
    <Link href={`/notes/${note.id}`}>
      <Card className={cn('hover:border-primary/40 transition-colors', note.isArchived && 'opacity-70')}>
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-between">
            <CardTitle className="truncate">{note.title}</CardTitle>
            {note.isPinned && <Pin size={16} className="text-yellow-600" />}
          </div>
          <div className="flex items-center justify-between">
            {note.category ? (
              <Badge
                style={note.category.color ? { backgroundColor: note.category.color } : undefined}
                variant={note.category.color ? 'default' : 'secondary'}
              >
                {note.category.name}
              </Badge>
            ) : (
              <span className="text-muted-foreground text-xs">No category</span>
            )}
            <CardDescription>
              Updated {new Date(note.updatedAt).toLocaleDateString()}
            </CardDescription>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}
```

```typescript
// /components/dashboard/pagination.tsx
'use client';

import { Button } from '@/components/ui/button';

type Props = {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
};

export function Pagination({ page, totalPages, onPageChange }: Props) {
  return (
    <div className="flex items-center justify-center gap-2 py-2">
      <Button variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        Previous
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button variant="outline" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        Next
      </Button>
    </div>
  );
}
```

```typescript
// /components/common/empty-state.tsx
type EmptyStateProps = {
  title: string;
  description?: string;
};
export default function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <h3 className="text-lg font-medium">{title}</h3>
      {description && <p className="text-muted-foreground mt-1">{description}</p>}
    </div>
  );
}
```

#### State Management
- Server-side state:
  - Data fetching occurs in server components via server actions to keep secrets server-side and minimize client payload.
- Client-side state:
  - Filters, search, sort, and pagination are stored in URL search params. Client components update the URL using next/navigation router. This enables shareable links and preserves state on reload.
  - Framer Motion manages transient animation state for list transitions.
- Zustand/TipTap:
  - Not required for the dashboard. Zustand remains dedicated to the editor feature; TipTap data is not rendered here beyond titles/metadata.

### Dependencies & Integrations
- Clerk.dev: Used to scope queries to the authenticated user via auth() in server actions.
- Supabase + Drizzle ORM: Storage and querying of notes and categories.
- ShadCN UI + Tailwind: UI components (Input, Select, Badge, Card, Button) and styling.
- Framer Motion: Animations for grid transitions.
- Next.js 14 App Router: Server components + server actions; routing and searchParams.
- No additional npm packages are required beyond the CodeSpring stack. lucide-react icons are commonly available via ShadCN setup; if not present, add lucide-react.

Integration points with other features:
- Note Management: Clicking a card links to /notes/[id] for editing with TipTap.
- Category Assignment: Uses categories table to filter notes.

### Implementation Steps
1. Create database schema
   - Add /db/schema/notes.ts (as above)
   - Run Drizzle migration to create notes and categories tables
2. Generate queries
   - Ensure db instance is configured for Supabase
   - Add relations and indexes as defined
3. Implement server actions
   - Create /actions/dashboard-actions.ts with listNotesForDashboard and listCategoriesForUser
   - Validate inputs with zod
4. Build UI components
   - Create dashboard page and client wrapper
   - Implement Filters, NotesGrid, NoteCard, Pagination, EmptyState
5. Connect frontend to backend
   - Wire server actions in /app/(app)/dashboard/page.tsx
   - Pass data and query props to DashboardClient; update URL on filter changes
6. Add error handling
   - Wrap calls in try/catch in server actions; log and rethrow generic errors
   - Add 500 error boundary if project uses one; display empty state or toast as needed
7. Test the feature
   - Unit test server actions and query logic
   - Integration test page rendering with various searchParams
   - UAT with real data on Vercel preview

### Edge Cases & Error Handling
- No notes exist: Show EmptyState with create suggestion (link to create note if available).
- Category filter invalid/UUID malformed: Validation drops it (treated as “all”).
- Search too long or special characters: Truncated to 200 chars via zod; ilike handles case-insensitive substring.
- Unauthorized access: auth() missing userId throws; Next.js redirects to sign-in via middleware.
- Large datasets: Pagination enforced with limit/offset; indexes provided for userId and updatedAt.
- Archived notes: Hidden by default; includeArchived toggle reveals them.
- Orphaned categoryId: Handled via left join; displays “No category”.
- DB errors/timeouts: Catch, log, return generic error; optionally surface a toast/snackbar on client.

### Testing Approach
- Unit tests
  - dashboard-actions: validate dashboardQuerySchema parsing (valid and invalid inputs)
  - listNotesForDashboard: builds correct where/order for combinations (mock db adapter)
  - listCategoriesForUser: returns only user’s categories
- Integration tests
  - Render /dashboard with no data -> empty state
  - With data: verify default ordering (updated desc)
  - Apply category filter and search via URL; results reflect filters
  - Pagination controls change page and fetch new data
  - IncludeArchived toggle shows archived notes
- User Acceptance Tests
  - Login -> redirected to dashboard
  - Scroll and open a note -> navigates to /notes/[id]
  - Change sort, filter, search -> URL updates and state persists on refresh
  - Performance: initial load under acceptable threshold (SSR), transitions smooth

Notes:
- Ensure route-level authentication guard aligns with project middleware (e.g., withAuth).
- If using caching, avoid caching per-user data or use cache tags scoped by userId; default to dynamic rendering for safety in MVP.

### Implementation Status (UI-Only, as of now)
- Implemented dashboard UI with mock data only; no database or server actions.
- Added components:
  - `components/dashboard/filters.tsx` (search, category, sort, archived toggle)
  - `components/dashboard/notes-grid.tsx`
  - `components/dashboard/note-card.tsx`
  - `components/dashboard/pagination.tsx`
  - `components/common/empty-state.tsx`
- Updated `app/dashboard/page.tsx` to client-side state and in-memory filtering/sorting/pagination.
- Added a “New Note” button linking to `/notes/new`.
- Created `/app/notes/new/page.tsx` as a UI-only create form (title + content); Save simulates a save and routes back to `/dashboard`.

### Discrepancies vs PRD (Planned vs Built)
- Data fetching and server actions: PRD calls for server actions (`listNotesForDashboard`, `listCategoriesForUser`) and Drizzle queries; NOT implemented yet (intentionally deferred per requirement to avoid backend).
- Database schema: PRD details `notes` and `categories` schema; NOT created yet.
- SSR and auth scoping: PRD expects server components with Clerk `auth()`; current page is a client component using mock data only.
- Pagination: Implemented client-side paging with page size 20; matches PRD behavior but without total count from DB.
- Category filter: Implemented with mock categories; PRD expects user-scoped categories from DB.
- Sorting: Implemented `updated_desc`, `updated_asc`, `created_desc`, `title_asc` as per PRD.
- Pinned-first ordering: Implemented on the client as a stable secondary sort.
- Empty state: Implemented per PRD guidance.
- Performance/caching: Not applicable yet (no real data fetching).

### Next Steps to Align with PRD
1. Add Drizzle schemas and migrations for `notes` and `categories`.
2. Implement server actions for listing notes/categories with Clerk scoping.
3. Convert dashboard to server component fetching data via actions; keep client for interactions.
4. Wire real pagination and counts; preserve pinned-first ordering.
5. Replace mock categories with user data; add error handling.
6. Add basic tests for query parsing and UI states.
