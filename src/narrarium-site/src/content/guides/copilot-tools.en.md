# Copilot, Fantasmino and tools

Copilot and the voice assistant share the same orchestration engine. The difference is the input/output channel.

## Tool Registry

Tools are discoverable and individually configurable under **Settings → Tools**. The orchestrator prefers local/no-LLM tools when possible and uses Router tasks only when generation or reasoning is required.

Capabilities include creation and editing, search, navigation, read-aloud, canon, research, notes, Git branches/diffs/commits/PRs, evaluations, reader personas and exports.

## Chat

Chat renders Markdown, streams conversational responses, supports Shift+Enter submission, formatted/Markdown copy, saving to notes and PDF/Markdown download or Drive upload.

A long text you paste (a synopsis, an analysis, a chapter) is material to read, not your request: what you ask is the line you write before or after it, and the words of the text never decide it, so a request that is not clearly a refusal is always answered by the model, which reads the text as data. **Use this text as material**, under the box when a text is long, sets it apart as an attachment in one click and leaves in the box only the line that asks. When a request had to be cut to fit the context window of a model, the reply says so, how much was sent and where to set the window; a text you set apart as material is never cut by the limits of the attachments, and when those cut the text of the files you attached, the reply says how much was read.

Next to **Send** a ring shows how much of the model's context window the next message takes, with its state in words too (getting full, compacting, over the window); hovered or focused it says the numbers and where the window comes from (the model's configuration in **AI Integrations**, or the default of 128,000 tokens). Pressed, it shows what the next message carries part by part (instructions and tools, canon and files, the page, attachments and material, the compacted summary, the conversation, your message), the share a provider may serve from its cache and the share it reported for the last request, and the cost at the model's prices. When the next message would reach 90% of the window the chat compacts by itself: the older part of the conversation is summarised (by the **Chat resume** task of the AI Router, or from the messages themselves when it does not answer) and the requests carry the summary and the recent messages, while every message stays in the chat. The marker in the chat shows the summary, and **Undo for the next message** sends what it summarised as it is, once. `/compact` compacts now and `/context` prints what the next message carries, as a note of the chat that is never sent; typing `/` opens the list of commands. A message that does not fit even after the compaction is not sent: the chat says so with the numbers and offers to attach it as material, to shorten it or to choose a model with a larger window. The switch and the threshold are in **Settings → Tools → Context of the chats**.

## The page you are on

On some pages the Copilot works on the page first: the line above its composer says which («Working on: Simulated readers»). It sees what the page shows, not only where you are: on **Simulated readers**, every reader of the book (the built-in ones included) with whether it is on, its type, its severity and the genres it likes, and the filter and the reader you have open. The pages that work this way are **Simulated readers**, **Ghostwriters**, **Director**, **Evaluation style**, the autopilot's **Configuration**, **Assets**, and the page of a character, a location, a faction or an item. A request that could be about the page is about it; everything else the Copilot can do stays available on every page, the tools of the other pages included.

When the model of the Copilot's route can call tools, it chooses its tools itself, the page's first, in a short loop: it reads what it needs, answers you, or proposes a change; a tool of the catalogue runs with your own words. A model marked as without tool calls in **AI Integrations** is helped by the keyword rules, as before, with the page's own rule first.

## Changing the simulated readers

On **Simulated readers**, ask in your words, in English or in Italian: «create only historical readers of different kinds and turn off all the default ones», «make the critical reader harsher», «turn on the mystery reader». The Copilot proposes one batch: readers created (several at once, written by one call of the model, each a different kind of reader), edited, turned on or off, and removed. **Built-in readers are never deleted**: removing one turns it off. Before anything is written you see a table of every reader with what it is now, what it will be and what changes, the changes first. **Apply** writes the whole batch in one change of the book (on a book on GitHub it is published at once when GitHub can be reached, as every change the Copilot applies; otherwise it is saved on this device, and the next sync publishes it); **Discard** drops it; once applied, **Undo** puts back what was there. The page shows the new readers as soon as the batch is applied. **Change This Page** in **Settings → Tools** turns the batch on or off.

## Changing the other pages

The other pages work the same way: one proposal, a table of everything with its resulting state, **Apply**, **Discard** and **Undo**, and the page shows the change as soon as it is applied (a profile you are editing is not replaced: the page tells you it changed).

- **Ghostwriters**: ghostwriters created, edited (tone, voice, point of view, tense, rhythm, dialogue, vocabulary, style, influences, strengths, what to avoid, temperature, style instructions) and removed. The book's default ghostwriter, and the last one, are never removed.
- **Director**: its fields, each shown before and after (autonomy, strictness, approval score, review rounds, priorities, taste, red lines, the weight of each reader, the vision). A director the book has not saved yet starts from the default one.
- **Evaluation style**: criteria added, reworded and removed, and the method and severity.
- **A character, a location, a faction or an item**: the facts of its kind and its description, field by field. The Copilot never sees nor writes what points to a secret or your private notes (`secret_refs`, `private_notes`, `reveal_in`, `known_from`), never renames the entry, and the secrets and the timeline are not part of it.

On the autopilot's **Configuration** the Copilot sees the settings and the brief of the Synopsis and tells you what to change in which tab: the configuration is saved there, through the autopilot. On **Assets** it sees which images are made and which are missing, and the filter you chose; an image is made with the action of its card, which shows the prompt and asks before spending.
