import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/components/ui/use-toast";
import { LOCAL_REWRITE_DATABASE_BLOCKED_EVENT } from "@/repository/localRewriteOperationStore";

export function useRewriteDatabaseBlockedNotification(): void {
  const { t } = useTranslation();
  const { toast } = useToast();
  useEffect(() => {
    const notify = () => toast({ title: t("rewriteDatabase.blockedTitle"), description: t("rewriteDatabase.blockedDescription"), variant: "destructive" });
    window.addEventListener(LOCAL_REWRITE_DATABASE_BLOCKED_EVENT, notify);
    return () => window.removeEventListener(LOCAL_REWRITE_DATABASE_BLOCKED_EVENT, notify);
  }, [t, toast]);
}
