# AI integrations and Router

Narrarium uses your AI integrations. Add Azure OpenAI, OpenAI-compatible endpoints or GitHub Models in **Settings → AI Integrations**, which also holds keys, models, prices and default models. Then choose in **Settings → AI Router** which model handles each task.

## GitHub Models quick start

Create a GitHub PAT authorized for GitHub Models, add a **GitHub Models** integration in **AI Integrations**, load the model catalog and assign capabilities to the models you want to use.

## Reading the models of an endpoint

In the card of an **OpenAI / compatible** integration, two buttons next to the key work with the address and the key as they are written. They are not there for Azure OpenAI, GitHub Models or Microsoft 365 Copilot, which have no such list.

**Check the connection** asks the endpoint one short question, its list of models, and says in one line how fast it answered and how many models it lists («Responds in 120 ms · 6 models»), or what to correct: error 401 is the key, 404 an address that does not end with the version path (for example */v1*), 429 and 5xx an endpoint that is limiting requests or busy. When nothing answers, a browser cannot tell a server that is off from a wrong address or from a server that does not allow this site (CORS), and the line says so; the engine's own words are in the technical details. The error panel of the autopilot offers the same check, with the same result and a link to the card, on the integration of the step that failed, for network, authentication, timeout and provider failures; when the run is on your personal server, the check still asks from your browser.

**Read the models from the endpoint** opens a list of what the endpoint says it has, by kind (text, images, text-to-speech, transcription, embedding, other), with the context window, the largest answer and what each model can do (tool calls, streaming, reasoning, vision), and whether the integration already has it. It reads */models* (the list, needed) and, when the gateway has them, */models/details* and */modalities* (LlmProxy's: the limits, the capabilities and the kind of each model). Without them the dialog says «Only /models», lists every model as text and ticks none, because nothing says which of them chat.

Tick what to add or update and press **Add/update N models**. The new text models are ticked at first. A model you already have is updated only where it is empty (its limits and the capabilities the endpoint declares); what you wrote is never overwritten: your numbers, a capability you set (a switch turned off included), its roles, names, prices and Thinking parameter. A capability the endpoint does not declare is not turned into a restriction. A new model gets what the endpoint declares of it, and the first model of an integration that has none takes the default roles. For a name that the engine knows (Muse Glimmer today) the dialog suggests the **Thinking parameter** *chat_template_kwargs.reasoning_strength*, already ticked, and you can untick it before confirming. A model that is not for chat can be set as the image, text-to-speech or transcription model of the integration while that field is empty.

**Load models from API**, in the list of chat models, still works, for endpoints that answer in a simpler way.

## Task routing

**AI Router** has one table for each kind of task: **Text (chat)**, **Text-to-speech (TTS)**, **Speech-to-text (STT)** and **Images**. A table lists the endpoint (the integration) and the model of each task; the text table also has **Thinking**, and its first row, **Default**, is used by every task that has no route of its own. A row without a choice of its own shows, dimmed, what Narrarium would use. The privacy of fallbacks and the execution limits are in the box **Routing options**.

The tabs above a table are the **Primary** and the **fallbacks**, tried in order when the primary fails (rate limit, network). Every tab works the same way, with the same filters and the same group editing. **New tab** adds a fallback level, up to the maximum number of candidates in *Routing options*. **Swap with…** exchanges the targets of two tabs, thinking included, for the selected rows or, with nothing selected, for all of them; it tells what it did and offers **Undo**. The **…** menu moves a tab left or right (a swap with its neighbour) and deletes it, after asking how many rows lose it.

**Tools only** is the switch at the top of the page. With it on (the default) every agent of the autopilot (writer, director, readers, specialists, summaries) and every structured answer of the Copilot (an evaluation, a yes/no confirmation) answers by calling its own function, and not with a JSON written in the message: a model marked as without tool calls is skipped, and a reply in text instead of the call is refused. When no model of a task can call a function, the autopilot stops with **The AI configuration needs fixing**, and the page lists the tasks of the autopilot that are in this case under the switch; the Copilot says the same in the chat, with the same two ways out. To use such a model, turn on **Forced tool calls** for it in **AI Integrations**, or turn the switch off. The prose of the Copilot is never affected.

**Thinking** is how hard a model is asked to think. *Low*, *Medium*, *High* and *Extra high* are sent to the provider; *Automatic* sends nothing; *Inherit from integration* takes the **Default thinking** set in the card of the integration in **AI Integrations**. The level of a route always wins over the integration's. The **Default** row has no level of its own, because it only chooses the endpoint of the tasks without a route: they use the one of the endpoint. A model that does not reason may refuse a level (error 400): choose *Automatic* for it.

## Editing many tasks at once

In the text table, filter by group (Autopilot, Copilot and actions, Review, Research), by name, or with **Only customized**. Tick the rows, or **Select all visible tasks**, and use the panel that appears: choose the **endpoint**, then the **model** (only models valid for every selected task), then the **thinking**, and press **Apply**. Nothing changes until you do. What you do not choose stays as it was, so you can change endpoint and model and leave the thinking, change only the model, or change everything. When the new endpoint does not have the model of a row, that row takes the first valid one and the message says so. A fallback needs a primary: rows without one are skipped, and the message says so too.

## Thinking

For chat tasks, **Thinking** is how much the model is asked to think before it answers (the provider's *reasoning_effort* setting). **Low** is fast; **High** and **Extra high** are slower and use more tokens. **Automatic** sends nothing, and a blank value takes the level of the integration. Each target has its own: the primary and every fallback. The Copilot sends a level only when it is explicit.

**Thinking parameter** is how the level reaches a model, and it is set per model, in the card of the integration in **AI Integrations**, next to **Forced tool calls**. By default the level goes as *reasoning_effort*, the OpenAI field. Muse Glimmer on llama.cpp takes it as *chat_template_kwargs.reasoning_strength* and ignores *reasoning_effort*: for a model with that name the card suggests it, and **Use it** applies it, never by itself. *none* sends no level to that model, and it does not turn thinking off. It works the same for the autopilot and for the Copilot, and the debug panel says when a level went as the argument of the chat template.

A model that cannot call tools is marked **no tool calls**: the structured steps of the autopilot and of the Copilot cannot use it while *Tools only* is on.

Browser TTS and STT are virtual Router integrations and do not consume AI tokens.

## Timeouts and streaming

Every integration in **AI Integrations** has three settings that decide how long a slow model is given. The autopilot and the Copilot use them in the browser, and the autopilot on your personal server too (they go with your AI configuration, so send it again after a change).

- **Provider timeout (ms)**: how long the provider may take to start answering. The minimum is 30,000 ms (a lower value is raised to it, and the setting keeps what you wrote) and empty means 600,000 ms (10 minutes). Voice and images count it as the time of the whole request instead, 60,000 ms when it is empty.
- **Idle timeout (ms)**: the longest silence between two pieces of a streamed reply, from 30,000 to 3,600,000 ms; empty means 600,000 ms. Every piece that arrives starts the count again, so a model that keeps writing is never cut off, however long it takes (one call lasts four hours at most). It is not used while Streaming is Off.
- **Streaming**: with **Automatic (recommended)** every reply of the autopilot and of the Copilot arrives in pieces, the structured ones too, so a slow model is not cut off by a proxy or a tunnel that closes a connection that stays silent. Choose **Off** only if the provider refuses streamed replies together with function calls: its error is a 400 that mentions stream, and the message tells you to set **Streaming** of the integration to off. With Off the whole reply has to arrive within the provider timeout.

When a step fails because the response was too slow, the technical details of the error say which wait ran out and which of these settings to change (the Copilot writes the same sentence in the chat). A personal server older than 0.1.7 does not know **Idle timeout (ms)** and **Streaming**: it waits as it always did until you update it (**Version and updates** in **Settings → Personal server**).

**Passing errors.** When the provider answers the Copilot with a passing error (a 429, a 500, 502, 503 or 504, or a connection that drops, as a flaky node or a tunnel does now and then) the Copilot does not give up at the first one: it asks the same model again, at most two more times, after about 1 s and then about 3 s, never sooner than the provider asks and not at all if the provider asks for more than 10 s, and only while the **Total routing time (ms)** leaves room for it. The chat says it quietly, once for each retry («The provider answered with a passing error: trying again in 3 s (2 of 3)…»), and a reply that had begun to arrive starts over from the beginning. **Stop** ends the wait at once and is never shown as an error. Each attempt is a line of its own in the panel of AI requests and in the costs. A request that ran out of time (**Provider timeout (ms)**, **Idle timeout (ms)**), a request the provider refused (400, 401, 403, 404…), a reply that was refused and a prompt that does not fit are never repeated. After the third attempt the Copilot goes on as it always did: to the next model of the route, or to the error, in the words of the provider.

## Costs

When pricing is configured in AI Integrations, Narrarium records input, cached-input and output tokens plus media costs. Reader evaluations save their own provider/model/token/cost metadata while using the same cost engine.
