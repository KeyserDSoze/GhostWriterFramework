import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Settings,
  PlusCircle,
  Library,
  MessagesSquare,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settingsStore";
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
  const topNav: NavItem[] = [
    { label: t("nav.books"), href: "/app/books", icon: <Library className="h-4 w-4" /> },
    { label: "Chat", href: "/app/chats", icon: <MessagesSquare className="h-4 w-4" /> },
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
  ];

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
            <Separator className="mx-2 my-3" />
            <p className="px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("nav.myBooks")}
            </p>
            <nav className="px-2 space-y-1">
              {settings.books.map((book) => (
                <NavLink
                  key={book.id}
                  item={{
                    label: book.name,
                    href: `/app/books/${book.id}`,
                    icon: <BookOpen className="h-4 w-4" />,
                  }}
                  active={location.pathname.startsWith(`/app/books/${book.id}`)}
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
