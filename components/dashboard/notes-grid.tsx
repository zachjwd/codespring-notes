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


