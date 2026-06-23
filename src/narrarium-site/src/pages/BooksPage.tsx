import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("books.title")}</h1>
          <p className="text-muted-foreground">
            {t("books.subtitle")}
          </p>
        </div>
        <Button asChild>
          <Link to="/app/books/add">
            <PlusCircle className="mr-2 h-4 w-4" />
            {t("books.addBook")}
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
                      {t("books.added")}{" "}
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
                className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-background/80 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:hidden sm:group-hover:flex"
                aria-label={t("books.removeAria", { name: book.name })}
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
            <DialogTitle>{t("books.removeBook")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("books.removeBookDescription", { name: toDelete?.name })}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleting}>
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? t("books.removing") : t("books.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border py-20 text-center">
      <BookOpen className="mb-4 h-12 w-12 text-muted-foreground" />
      <h2 className="text-lg font-semibold">{t("books.emptyTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("books.emptyDescription")}
      </p>
      <Button asChild className="mt-4">
        <Link to="/app/books/add">
          <PlusCircle className="mr-2 h-4 w-4" />
          {t("books.addFirst")}
        </Link>
      </Button>
    </div>
  );
}
