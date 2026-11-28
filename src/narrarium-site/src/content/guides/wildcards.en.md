# Wildcards (Fuori dal coro)

The wildcards are a writers' room next to the director, the ghostwriters and the simulated readers. The readers judge and give a score; the wildcards **propose and check**: they give ideas and findings, never a score, and nothing they say is applied by itself. You decide what to keep.

## Provocateurs and sentinels

Fourteen wildcards come with Narrarium, in English and Italian, in two groups.

- **Provocateurs** give ideas: the Subversive (turns the premises upside down), the Devil's Advocate (the strongest objection to each choice, and the pre-mortem: why the book will fail), the Cliché Hunter, the Twist Engineer, the Genre Guest (what a noir, horror or comic author would do here), the Naive (the obvious «why?»), the Antagonist (an agenda for the villain and the secondary characters), the Chaos Maker (constraints such as «without dialogue») and the Poet.
- **Sentinels** check what is there: the Ledger Keeper (every promise gets its payoff), the Continuity Keeper, the Secrets Guardian, the Domain Expert (you choose the domain: a robotics engineer, a lawyer, a historian) and the Moral Stress-Test.

Each one has a mandate, a temperament, an **audacity** from 1 (prudent) to 10 (reckless), a **respect for the canon** (faithful, flexible or subversive) and says what it gives (ideas, objections, questions, constraints or findings). Three presets choose who is asked: **Creative room**, **Pre-mortem** and **Narrative quality check**.

## The Wildcards page

Open **Wildcards** in the **Profiles** group of the book's menu. The list shows every wildcard with its group, where it comes from (built-in, your account, this book) and a switch to turn it on or off; **Show** filters provocateurs, sentinels or your own. Choose one to see and change everything about it: its name, group, mandate, temperament, audacity, respect for the canon, what it gives, its domain and its prompt.

**Where your changes go** decides where a change is saved:

- **This book** writes the wildcard into the book (`wildcards/<slug>.md`): you and the autopilot use it in this book. A built-in wildcard you change gets a file of its own; **Restore default** removes it.
- **All my books** keeps the wildcard with your account, synchronised like your settings, and you use it in every book when you consult the room yourself. The autopilot uses the room of the book, also on your personal server: **Copy to this book** gives it a wildcard of yours.

**New wildcard** starts one of your own, **Duplicate** copies the one you are looking at, **Export** downloads its file (`<slug>.wildcard.md`) and **Import** adds files (one or more) where your changes go. A file that cannot be read whole is never asked, and the page says what is wrong with it.

## Secrets

Only a sentinel may know the secrets as you do (the Secrets Guardian does, to catch an involuntary spoiler). Every other wildcard knows only the secrets the text already reached, never one still hidden there.

## Out-of-the-box ideas on a selection, a scene or a chapter

Right-click a selection in a scene, a scene or a chapter and choose **Out-of-the-box ideas…**. Choose who is asked (**Creative room**, **Pre-mortem**, **Narrative quality check**, or the voices one by one) and, if you like, what you ask; the dialog says what the consultation will cost before it starts. The ideas arrive in a table: who gave each, why it works, what it changes and its risk. **Accept** or **Skip** each one (or all at once), then press the one button:

- the decisions are kept in the journal of the room (`bible/ideas.yml`), so the room does not propose again what you skipped;
- for a selection or a scene, the ghostwriter rewrites it using the accepted ideas as material, and you see the difference before keeping it;
- for a chapter, the accepted ideas are added to its entry in the Synopsis, which the autopilot follows (for a chapter already written it asks, or does, what you chose for a changed entry).

Nothing is applied before you press the button, and nothing at all if you keep neither the rewrite nor the entry.

## Ask the room in Brainstorming

In Brainstorming (the Synopsis page), ask the room what it thinks: choose **Ask the room** among the starters, or ask in your words («what would the provocateurs change?», «run a pre-mortem»). Two to four voices read the Synopsis and answer in the chat, each as its own character, with ideas and never a score; then Brainstorming sums them up: what they agree on, the strongest idea, the risks. If you like an idea, ask Brainstorming to turn it into a proposal of the Synopsis, which you review and apply as always. The Secrets Guardian does not sit in Brainstorming's room: Brainstorming never sees the secrets.

## Ask the Copilot

Anywhere in a chapter or a scene, ask the Copilot «what do the provocateurs think of this chapter?» (or the sentinels, a pre-mortem, the Poet and the Antagonist by name). The voices answer in the chat, each as its own character, and the table of their ideas opens, where you accept or skip them and apply them as from a right click.

## With the Copilot on the Wildcards page

On the page the Copilot sees every wildcard and proposes changes as one batch: «create a provocateur who thinks like a hacker», «turn off the Chaos Maker», «make the Domain Expert a maritime lawyer». You see every wildcard with its state before anything is written, apply the batch in one go, and can undo it. The Copilot changes the room of the book: a built-in wildcard is turned off there, never deleted.

## In the autopilot

The autopilot asks the room only when you turn it on, and the director triages what it gives: adopted, adapted or rejected, always with the reason, in the journal of the room. Only the ideas it accepts go on, never as a score.

- **Before the review of a design.** In **Design the book**, tick **The wildcards read the design first** (or, in **Configuration** → **Review**, **Wildcards (Fuori dal coro)** → **Before the review of a design**). Before the director's first review a pre-mortem (the Devil's Advocate, the Naive, the Antagonist, the Ledger Keeper) says why the book would fail as planned and what would make it better, and the director folds what it accepts into its review. Once in each design.
- **When a review of the book stalls.** In **Configuration** → **Review**, **When a review of the book stalls**. It works with a round for the whole book (**Correct the book** or **Show me the corrections first**): when two rounds in a row raise nothing, the creative room reads the whole book instead of another identical round, and the ideas the director accepts feed its corrections of the book. At most as many times in one review as you allow (1 to 3).
- **Voices, consultations and money.** The same part has the voices of a consultation (1 to 8, 4 when blank), the consultations at a stall and the money cap of one consultation, and says what a consultation costs. On the Costs page these calls are the autopilot's. On a personal server it needs version 0.1.27 or later. The autopilot uses the room of the book: copy a wildcard of your account into the book to have it there.
