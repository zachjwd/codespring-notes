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


