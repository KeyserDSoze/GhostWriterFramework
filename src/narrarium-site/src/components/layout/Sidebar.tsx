import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Settings,
  PlusCircle,
  Library,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/settingsStore";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.href}
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

export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const { settings } = useSettingsStore();
  const topNav: NavItem[] = [
    { label: t("nav.books"), href: "/app/books", icon: <Library className="h-4 w-4" /> },
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
    <aside className="flex h-full w-60 flex-col border-r bg-card">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-4">
        <BookOpen className="h-6 w-6 text-primary" />
        <span className="font-semibold text-base leading-tight">
          Narrarium
        </span>
      </div>
      <Separator />

      <ScrollArea className="flex-1 py-2">
        {/* Main nav */}
        <nav className="px-2 space-y-1">
          {topNav.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={location.pathname === item.href}
            />
          ))}
        </nav>

        {/* Books list */}
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
                />
              ))}
            </nav>
          </>
        )}
      </ScrollArea>
    </aside>
  );
}
