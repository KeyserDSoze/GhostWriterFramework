/**
 * The highlighter of the annotations, drawn here (Lucide's icon, ISC): the library's own icon would be a chunk that the shell shares with the lazy pages that
 * also use it, and the shell would carry it for them. The `lucide-highlighter` class is the one the icon of the library has (menus check their icons by it).
 */
export function HighlighterIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`lucide lucide-highlighter ${className}`}>
      <path d="m9 11-6 6v3h9l3-3" />
      <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  );
}
