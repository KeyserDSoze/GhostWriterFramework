/** The id of the card of an integration on the settings page: the link «Open this integration» of the error panel of the autopilot leads to `#integration-<id>`. */
export const integrationAnchor = (id: string): string => `integration-${id}`;

/** The address of the card of an integration, with its id written the way an address carries it (an id may have a slash or a colon). */
export const integrationLink = (id: string): string => `/app/settings/ai-integrations#${encodeURIComponent(integrationAnchor(id))}`;
