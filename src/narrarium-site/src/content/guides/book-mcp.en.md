# MCP server of a book

Every book on your personal server can have its own **MCP server**: an address of the server (`/mcp/<name>`) where an assistant such as Claude Code, Cursor, VS Code, ChatGPT or Claude.ai reads the book and edits it with tools like the Narrarium Copilot's (the [Model Context Protocol](https://modelcontextprotocol.io)). It is off for every book until you switch it on, one book at a time. The public [MCP page](/mcp) lists every tool an assistant gets, with what each permission allows.

## Where it is

Open the book and go to **Book settings**: the **MCP server** section is at the bottom of the page. What you change there applies at once on the server, without **Save**. The section is for a book that is on your personal server (move it there from **Where it runs**, on the **Live** page of its autopilot); for any other book it has one line with the way to **Settings** → **Personal server**. A server too old for it says so: update it from the same settings.

## Switch it on

Turn on **MCP server for this book**. The section then shows the **Address** of the book, with a button that copies it, and its **Address name**, the last part of the address: lowercase letters, digits and single hyphens, up to 80 characters. **Change the address** gives it another name; if the server refuses one (another book has it, or it is not a valid name), the field says why.

Switching it off, or changing the address, **disconnects every app** connected to the book: each has to ask you again, and every assistant needs the new address. The page asks before doing either, and says how many apps are connected.

If the server has no public address yet, the address works only on the computer that runs the server, and the section says so with the server's own words: ChatGPT, Claude.ai and assistants on other devices need a public **https** address, which you set in the admin panel of the server (**Approved network**).

## Claude Code, Cursor and VS Code

These assistants send a **token** in a header. Create one for the assistant in the admin panel of the server (**Clients**), with only the permissions it needs, and put it in place of `YOUR_TOKEN` in the configuration the section shows for each of them, for example:

```bash
claude mcp add --transport http the-glass-harbor https://books.example.net/mcp/the-glass-harbor \
  --header "Authorization: Bearer YOUR_TOKEN"
```

The token goes in the `Authorization` header, never in the address. Narrarium never shows the token of this device.

## ChatGPT and Claude.ai

On a server that lets apps connect by themselves (through OAuth), paste the address: in Claude.ai as a custom connector, in ChatGPT as a connector in developer mode, with OAuth. A page of **your** server opens: you prove that it is you with a **passkey** (or the admin code) and choose what the app may do. Read only is the default; changing the book and controlling the autopilot stay off until you turn them on.

**Connected apps** lists the apps connected to the book: the name the app gave itself, what it may do (read the book, change the book, control the autopilot), the address it goes back to, when it was connected and when it was last used. **Revoke** disconnects one, after asking; **Refresh the list** reads it again, for an app you have just allowed. Your passkeys and the log of the latest calls are in the admin panel of the server, under **Connected apps (MCP)**.

## The Synopsis

An assistant that may read the book can read its **Synopsis** (your chapter-by-chapter plan, which the autopilot follows) with two tools: `read_outline`, which gives the description of the book and the entries a page at a time (it can also look for a number or some words), and `read_outline_entry`, which gives one entry whole, with whether its chapter is already written or frozen and what the autopilot would do if the entry changed. An assistant that may change the book edits the Synopsis with `edit_outline`: up to 50 edits in a row (add, insert, move, remove or change an entry, change the description of the book), saved together as **one commit** that you can undo. The Synopsis is changed only this way, like the Copilot's «Edit the Synopsis» tool: the assistant cannot write its files as plain files. What it writes there is **yours** (the autopilot follows it and never rewrites it). It can replace the text of an entry only after reading it, and if you changed it meanwhile nothing is written. A change that would touch more than 1,000 files (for example a new chapter at the head of a very long synopsis) is left to you, in the Synopsis page.

## The risk

A model that reads the book reads text, and text can say anything: it can be talked into using the tools (this is called prompt injection). So give write access only to apps you trust, give each assistant only the permissions it needs, and switch the MCP server off for a book you do not work on with an assistant. Every change an assistant makes is a commit of the book, which you can undo.
