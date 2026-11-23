import { Badge } from "@/components/ui/badge";

/** The opening of a public page: a small label, the title of the page and one sentence under it. */
export function PageHero({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 lg:px-8"><Badge variant="secondary">{eyebrow}</Badge><h1 className="mt-4 max-w-4xl font-serif text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1><p className="mt-4 max-w-3xl text-lg leading-8 text-muted-foreground">{text}</p></section>;
}
