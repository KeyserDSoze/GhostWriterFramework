import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  BookText,
  ClipboardCheck,
  Clock,
  Coins,
  EyeOff,
  FileEdit,
  FileText,
  Images,
  LayoutDashboard,
  Library,
  MapPin,
  MessagesSquare,
  Network,
  NotebookText,
  Package,
  PenLine,
  PlusCircle,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { parseAppRoute } from "@/assistant/context";
import { APP_VERSION } from "@/config/version";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={item.href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {item.icon}
      {item.label}
    </Link>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { settings } = useSettingsStore();
  const { structures } = useBooksStore();
  const route = parseAppRoute(location.pathname);
  const bookId = "bookId" in route ? route.bookId : undefined;
  const chapterId = "chapterId" in route ? route.chapterId : undefined;
  const paragraphNum = "paragraphNum" in route ? route.paragraphNum : undefined;
  const structure = bookId ? structures[bookId] : undefined;
  const chapter = chapterId && structure ? structure.chapters.find((c) => c.slug === chapterId) : undefined;
  const paragraph = paragraphNum && chapter ? chapter.paragraphs.find((p) => p.number === paragraphNum) : undefined;
  const book = bookId ? settings.books.find((b) => b.id === bookId) : undefined;

  const topNav: NavItem[] = [
    { label: t("nav.books"), href: "/app/books", icon: <Library className="h-4 w-4" /> },
    { label: t("chats.title"), href: "/app/chats", icon: <MessagesSquare className="h-4 w-4" /> },
    {
      label: t("nav.addBook"),
      href: "/app/books/add",
      icon: <PlusCircle className="h-4 w-4" />,
    },
    {
      label: t("nav.settings"),
      href: "/app/settings",
      icon: <Settings className="h-4 w-4" />,
    },
    {
      label: t("costs.title"),
      href: "/app/costs",
      icon: <Coins className="h-4 w-4" />,
    },
    {
      label: t("nav.docs"),
      href: "/app/docs",
      icon: <BookText className="h-4 w-4" />,
    },
  ];

  const bookNav: NavItem[] = bookId
    ? [
        { label: t("nav.bookOverview"), href: `/app/books/${bookId}`, icon: <BookOpen className="h-4 w-4" /> },
        { label: t("dashboard.title"), href: `/app/books/${bookId}/dashboard`, icon: <LayoutDashboard className="h-4 w-4" /> },
        { label: t("ghostwriters.title"), href: `/app/books/${bookId}/ghostwriters`, icon: <Users className="h-4 w-4" /> },
        { label: t("writingStyle.title"), href: `/app/books/${bookId}/writing-style`, icon: <FileText className="h-4 w-4" /> },
        { label: t("assets.title"), href: `/app/books/${bookId}/assets`, icon: <Images className="h-4 w-4" /> },
        { label: t("reader.title"), href: `/app/books/${bookId}/reader`, icon: <BookOpen className="h-4 w-4" /> },
        { label: t("bookPage.bookSettings"), href: `/app/books/${bookId}/settings`, icon: <Settings className="h-4 w-4" /> },
      ]
    : [];

  const canonNav: NavItem[] = bookId
    ? [
        { label: t("bookPage.characters"), href: `/app/books/${bookId}#characters`, icon: <Users className="h-4 w-4" /> },
        { label: t("bookPage.locations"), href: `/app/books/${bookId}#locations`, icon: <MapPin className="h-4 w-4" /> },
        { label: t("bookPage.factions"), href: `/app/books/${bookId}#factions`, icon: <Shield className="h-4 w-4" /> },
        { label: t("bookPage.items"), href: `/app/books/${bookId}#items`, icon: <Package className="h-4 w-4" /> },
        { label: t("bookPage.timelines"), href: `/app/books/${bookId}#timelines`, icon: <Clock className="h-4 w-4" /> },
        { label: t("bookPage.secrets"), href: `/app/books/${bookId}#secrets`, icon: <EyeOff className="h-4 w-4" /> },
      ]
    : [];

  const chapterNav: NavItem[] = bookId && chapterId
    ? [
        { label: t("nav.chapterOverview"), href: `/app/books/${bookId}/chapters/${chapterId}`, icon: <FileText className="h-4 w-4" /> },
        { label: t("nav.draftsIndex"), href: `/app/books/${bookId}/chapters/${chapterId}/drafts`, icon: <FileEdit className="h-4 w-4" /> },
        { label: t("nav.scriptsIndex"), href: `/app/books/${bookId}/chapters/${chapterId}/scripts`, icon: <Network className="h-4 w-4" /> },
        { label: t("chapter.resume"), href: `/app/books/${bookId}/chapters/${chapterId}/workspace/resume`, icon: <NotebookText className="h-4 w-4" /> },
        { label: t("chapter.evaluation"), href: `/app/books/${bookId}/chapters/${chapterId}/workspace/evaluation`, icon: <ClipboardCheck className="h-4 w-4" /> },
        { label: t("writingStyle.chapterButton"), href: `/app/books/${bookId}/chapters/${chapterId}/writing-style`, icon: <PenLine className="h-4 w-4" /> },
      ]
    : [];

  const paragraphNav: NavItem[] = bookId && chapterId && paragraphNum
    ? [
        { label: t("nav.paragraphOverview"), href: `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraphNum}`, icon: <FileText className="h-4 w-4" /> },
        { label: t("chapter.script"), href: `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraphNum}/workspace/script`, icon: <Network className="h-4 w-4" /> },
        { label: t("chapter.draft"), href: `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraphNum}/workspace/draft`, icon: <FileEdit className="h-4 w-4" /> },
        { label: t("chapter.evaluation"), href: `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraphNum}/workspace/evaluation`, icon: <ClipboardCheck className="h-4 w-4" /> },
      ]
    : [];

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-4">
        <BookOpen className="h-6 w-6 text-primary" />
        <span className="font-semibold text-base leading-tight">Narrarium</span>
        <span className="ml-auto rounded-full border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          v{APP_VERSION}
        </span>
      </div>
      <Separator />

      <ScrollArea className="flex-1 py-2">
        {paragraphNav.length > 0 && (
          <>
            <NavGroup label={paragraph?.title ?? t("nav.currentParagraph")} first />
            <nav className="px-2 space-y-1">
              {paragraphNav.map((item) => (
                <NavLink key={item.href} item={item} active={location.pathname === item.href} onNavigate={onNavigate} />
              ))}
            </nav>
          </>
        )}

        {chapterNav.length > 0 && (
          <>
            <NavGroup label={chapter?.title ?? t("nav.currentChapter")} first={paragraphNav.length === 0} />
            <nav className="px-2 space-y-1">
              {chapterNav.map((item) => (
                <NavLink key={item.href} item={item} active={location.pathname === item.href} onNavigate={onNavigate} />
              ))}
            </nav>
          </>
        )}

        {bookId && (
          <>
            <NavGroup label={book?.name ?? t("nav.currentBook")} first={paragraphNav.length === 0 && chapterNav.length === 0} />
            <nav className="px-2 space-y-1">
              {bookNav.map((item) => (
                <NavLink key={item.href} item={item} active={location.pathname === item.href} onNavigate={onNavigate} />
              ))}
            </nav>
            <NavGroup label={t("nav.canon")} />
            <nav className="px-2 space-y-1">
              {canonNav.map((item) => (
                <NavLink key={item.href} item={item} active={false} onNavigate={onNavigate} />
              ))}
            </nav>
          </>
        )}

        <NavGroup label={t("nav.app")} first={!bookId} />
        <nav className="px-2 space-y-1">
          {topNav.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={location.pathname === item.href}
              onNavigate={onNavigate}
            />
          ))}
        </nav>

        {settings.books.length > 0 && (
          <>
            <NavGroup label={t("nav.myBooks")} />
            <nav className="px-2 space-y-1">
              {settings.books.map((entry) => (
                <NavLink
                  key={entry.id}
                  item={{
                    label: entry.name,
                    href: `/app/books/${entry.id}`,
                    icon: <BookOpen className="h-4 w-4" />,
                  }}
                  active={location.pathname === `/app/books/${entry.id}`}
                  onNavigate={onNavigate}
                />
              ))}
            </nav>
          </>
        )}
      </ScrollArea>
    </>
  );
}

function NavGroup({ label, first }: { label: string; first?: boolean }) {
  return (
    <>
      {!first && <Separator className="mx-2 my-3" />}
      <p className="truncate px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
    </>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <aside className="hidden h-full w-64 shrink-0 border-r bg-card lg:flex lg:flex-col">
      <SidebarContent onNavigate={onNavigate} />
    </aside>
  );
}

export function MobileSidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full max-h-[100dvh] w-full max-w-[86vw] flex-col bg-card sm:max-w-sm">
      <SidebarContent onNavigate={onNavigate} />
    </div>
  );
}
