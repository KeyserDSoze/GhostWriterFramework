/** The id of the card of an integration on the settings page: the link «Open this integration» of the error panel of the autopilot leads to `#integration-<id>`. */
export const integrationAnchor = (id: string): string => `integration-${id}`;

/** The address of the card of an integration, with its id written the way an address carries it (an id may have a slash or a colon). */
export const integrationLink = (id: string): string => `/app/settings/ai-integrations#${encodeURIComponent(integrationAnchor(id))}`;

/** The id of the prices of a chat model of an integration: a link to it opens the card of the integration and the prices of the model (the fix of «calls without a price»). */
export const modelPriceAnchor = (integrationId: string, modelId: string): string => `model-price-${integrationId}--${modelId}`;

/** The id of the prices of the voice and the images of an integration. */
export const mediaPriceAnchor = (integrationId: string): string => `media-price-${integrationId}`;

export const priceLink = (anchor: string): string => `/app/settings/ai-integrations#${encodeURIComponent(anchor)}`;
