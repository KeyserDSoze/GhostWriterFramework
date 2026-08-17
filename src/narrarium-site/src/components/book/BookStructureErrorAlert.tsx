import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { createLegacyRecoveryLoginRequest } from "@/auth/legacyRecoveryLogin";
import { createLegacyAdoptionConsent } from "@/auth/legacyAdoptionConsent";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/authStore";
import { LEGACY_REPOSITORY_ADOPTION_DECLINED, LEGACY_REPOSITORY_AUTH_REQUIRED, LEGACY_REPOSITORY_CHANGED, LEGACY_REPOSITORY_COPY_CONFLICT, type BookStructureLoadError } from "@/store/booksStore";

export function BookStructureErrorAlert({ error, reload }: { error: BookStructureLoadError; reload: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const beginInteractiveRecoveryAuth = useAuthStore((state) => state.beginInteractiveRecoveryAuth);
  const [confirmingAdoption, setConfirmingAdoption] = useState(false);
  const authRequired = error.code === LEGACY_REPOSITORY_AUTH_REQUIRED;
  const conflict = error.code === LEGACY_REPOSITORY_COPY_CONFLICT;
  const declined = error.code === LEGACY_REPOSITORY_ADOPTION_DECLINED;
  const changed = error.code === LEGACY_REPOSITORY_CHANGED;
  const legacy = authRequired || conflict || declined || changed;

  function recover() {
    if (!user) return;
    createLegacyRecoveryLoginRequest(user, `${location.pathname}${location.search}${location.hash}`);
    beginInteractiveRecoveryAuth();
    navigate("/login", { replace: true });
  }

  function confirmAdoption() {
    if (!user || !error.adoptionTarget) return;
    createLegacyAdoptionConsent(user, error.adoptionTarget);
    reload();
  }

  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      {legacy && <AlertTitle>{t(`bookStructureError.${error.code}.title`)}</AlertTitle>}
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{confirmingAdoption ? t(error.adoptionTarget?.replaceDisposableTarget ? "bookStructureError.adoptionConfirmReplace" : "bookStructureError.adoptionConfirm") : legacy ? t(`bookStructureError.${error.code}.description`) : error.message ?? t("common.loadFailed")}</span>
        {authRequired && user ? (
          <Button size="sm" onClick={recover}>{t(`bookStructureError.reauthenticate.${user.provider}`)}</Button>
        ) : conflict ? (
          <Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event("narrarium:open-repository-status"))}>{t("bookStructureError.repositoryStatus")}</Button>
        ) : declined && confirmingAdoption ? (
          <>
            <Button size="sm" onClick={confirmAdoption}>{t("bookStructureError.confirmAdoption")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingAdoption(false)}>{t("common.cancel")}</Button>
          </>
        ) : declined || changed ? (
          <>
            <Button size="sm" variant="outline" onClick={declined ? () => setConfirmingAdoption(true) : reload}>{declined ? t("bookStructureError.reviewAdoption") : t("bookStructureError.retryInspect")}</Button>
            {declined && <Button size="sm" variant="ghost" onClick={() => navigate("/app/books")}>{t("common.cancel")}</Button>}
          </>
        ) : !legacy ? (
          <Button size="sm" variant="outline" onClick={reload}>{t("common.reloadBook")}</Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
