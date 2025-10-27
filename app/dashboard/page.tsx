/**
 * Dashboard page UI (mocked)
 * Implements the Dashboard View PRD UI only (no data/actions)
 */
"use client";

import { useMemo, useState } from 'react';
import { Filters } from '@/components/dashboard/filters';
import { NotesGrid } from '@/components/dashboard/notes-grid';
import { Pagination } from '@/components/dashboard/pagination';
import EmptyState from '@/components/common/empty-state';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';

type Category = { id: string; name: string; color: string | null };
type Note = {
  id: string;
  title: string;
  isPinned: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  category?: { id: string; name: string; color: string | null } | null;
};

const MOCK_CATEGORIES: Category[] = [
  { id: 'all', name: 'All', color: null },
  { id: 'work', name: 'Work', color: '#fde68a' },
  { id: 'personal', name: 'Personal', color: '#bfdbfe' },
  { id: 'ideas', name: 'Ideas', color: '#c7d2fe' },
];

const MOCK_NOTES: Note[] = Array.from({ length: 42 }).map((_, i) => {
  const categoryPool = [null, { id: 'work', name: 'Work', color: '#fde68a' }, { id: 'personal', name: 'Personal', color: '#bfdbfe' }, { id: 'ideas', name: 'Ideas', color: '#c7d2fe' }];
  const category = categoryPool[i % categoryPool.length];
  return {
    id: String(i + 1),
    title: `Sample Note ${i + 1}`,
    isPinned: i % 7 === 0,
    isArchived: i % 11 === 0,
    createdAt: new Date(Date.now() - (i + 1) * 1000 * 60 * 60 * 24).toISOString(),
    updatedAt: new Date(Date.now() - i * 1000 * 60 * 60 * 12).toISOString(),
    category,
  };
});

export default function DashboardPage() {
  const [search, setSearch] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<'updated_desc' | 'updated_asc' | 'created_desc' | 'title_asc'>('updated_desc');
  const [includeArchived, setIncludeArchived] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const pageSize = 20;

  const onChangeParams = (params: Record<string, string | undefined>) => {
    if ('search' in params) setSearch(params.search ?? '');
    if ('categoryId' in params) setCategoryId(params.categoryId);
    if ('sort' in params) setSort((params.sort as any) ?? 'updated_desc');
    if ('includeArchived' in params) setIncludeArchived(Boolean(params.includeArchived));
    setPage(1);
  };

  const categories = useMemo(() => MOCK_CATEGORIES.filter((c) => c.id !== 'all'), []);

  const filtered = useMemo(() => {
    let data = MOCK_NOTES.slice();
    if (!includeArchived) data = data.filter((n) => !n.isArchived);
    if (categoryId) data = data.filter((n) => (n.category?.id ?? null) === categoryId);
    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter((n) => n.title.toLowerCase().includes(q));
    }

    switch (sort) {
      case 'updated_desc':
        data.sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
        break;
      case 'updated_asc':
        data.sort((a, b) => +new Date(a.updatedAt) - +new Date(b.updatedAt));
        break;
      case 'created_desc':
        data.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
        break;
      case 'title_asc':
        data.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }

    // pinned first
    data.sort((a, b) => Number(b.isPinned) - Number(a.isPinned));
    return data;
  }, [search, categoryId, sort, includeArchived]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  return (
    <main className="p-6 md:p-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <Button asChild>
          <Link href="/notes/new">
            <Plus className="mr-2 h-4 w-4" /> New Note
          </Link>
        </Button>
      </div>
      <div className="mx-auto max-w-6xl space-y-4">
        <Filters
          categories={categories}
          value={{ search, categoryId, sort, includeArchived }}
          onChange={onChangeParams}
        />

        {items.length === 0 ? (
          <EmptyState title="No notes found" description="Try creating a note or adjusting filters." />
        ) : (
          <>
            <NotesGrid items={items} />
            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </main>
  );
}