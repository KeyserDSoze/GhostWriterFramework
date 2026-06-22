import { useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, PlusCircle, Lock, Globe, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { useSettingsStore } from "@/store/settingsStore";
import { useSettings } from "@/drive/useSettings";
import { type BookEntry } from "@/types/settings";

export function BooksPage() {
  const { settings, patchSettings } = useSettingsStore();
  const { save } = useSettings();
  const books = settings.books;

  const [toDelete, setToDelete] = useState<BookEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    patchSettings({ books: settings.books.filter((b) => b.id !== toDelete.id) });
    await save();
    setDeleting(false);
    setToDelete(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Books</h1>
          <p className="text-muted-foreground">
            Manage your Narrarium books from GitHub repositories.
          </p>
        </div>
        <Button asChild>
          <Link to="/app/books/add">
            <PlusCircle className="mr-2 h-4 w-4" />
            Add Book
          </Link>
        </Button>
      </div>

      {books.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {books.map((book) => (
            <div key={book.id} className="relative group">
              <Link to={`/app/books/${book.id}`} className="no-underline block h-full">
                <Card className="h-full transition-shadow group-hover:shadow-md">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base line-clamp-1 pr-6">
                        {book.name}
                      </CardTitle>
                      <Badge
                        variant="outline"
                        className="ml-2 shrink-0 text-[10px]"
                      >
                        {book.bookToken || book.tokenIndex !== null ? (
                          <Lock className="mr-1 h-3 w-3" />
                        ) : (
                          <Globe className="mr-1 h-3 w-3" />
                        )}
                        {book.owner}/{book.repo}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs">
                      {book.owner}/{book.repo}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground">
                      Added{" "}
                      {new Date(book.addedAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </CardContent>
                </Card>
              </Link>
              {/* Delete button – floats over the card, only visible on hover */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  setToDelete(book);
                }}
                className="absolute top-2 right-2 z-10 hidden group-hover:flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                aria-label={`Remove ${book.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Confirmation dialog */}
      <Dialog open={!!toDelete} onOpenChange={(open) => { if (!open) setToDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove book?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <strong>{toDelete?.name}</strong> ({toDelete?.owner}/{toDelete?.repo}) will be
            removed from your list. The GitHub repository is not affected.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border py-20 text-center">
      <BookOpen className="mb-4 h-12 w-12 text-muted-foreground" />
      <h2 className="text-lg font-semibold">No books yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect a GitHub repository to start managing your Narrarium book.
      </p>
      <Button asChild className="mt-4">
        <Link to="/app/books/add">
          <PlusCircle className="mr-2 h-4 w-4" />
          Add your first book
        </Link>
      </Button>
    </div>
  );
}
