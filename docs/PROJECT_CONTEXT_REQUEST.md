# Request: Recover the original Beauty Platform project context

Claude Code: ChatGPT is now helping with development and needs the original product requirements, not just the current backlog.

Please review the previous conversations available to you across the different chats where the owner described the application, and compare those requirements with the actual repository state.

Prepare `docs/PROJECT_CONTEXT_FOR_CHATGPT.md` with:

1. **Product vision and business goals** — intended users, target market, value proposition, and how the product should differ from alternatives.
2. **Owner-confirmed requirements** — features, user journeys, UI/UX, business rules, roles, permissions, localization, booking, notifications, loyalty, catalog, and any other topics discussed.
3. **Explicit decisions and constraints** — what the owner asked to do, change, avoid, postpone, or leave undecided.
4. **Technical architecture** — stack, packages, API, database, authentication, authorization, testing, CI, and infrastructure.
5. **Implementation status** — completed, partially completed, missing, and known-broken work, verified against the repository rather than inferred from task titles.
6. **Development history and plan** — key decisions, task order, priorities, dependencies, and the next recommended tasks.
7. **Open questions and contradictions** — decisions that need the owner's input and any conflicts between past requirements and current implementation.
8. **Collaboration guidance** — how ChatGPT can review changes and coordinate with Claude without conflicting edits.

Important:
- Do not rely only on `docs/BACKLOG.md`; use the available conversation history as well as repository code and docs.
- Clearly label owner-confirmed requirements, recommendations, and assumptions separately.
- Do not invent requirements.
- Explicitly list which previous chats or sources were unavailable, so ChatGPT does not mistake partial history for the complete original vision.
- This request is for analysis and documentation only. Do not change application logic, deploy, or merge changes into `main`.

When finished, summarize the sources reviewed and the main findings, and tell ChatGPT where the context document is located.
