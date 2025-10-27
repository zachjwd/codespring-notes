import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Pin } from 'lucide-react';

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
      <Card className={`hover:border-primary/40 transition-colors ${note.isArchived ? 'opacity-70' : ''}`}>
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


