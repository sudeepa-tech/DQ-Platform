// Single configuration point for product naming. No brand name is
// hardcoded anywhere else in the app -- everything imports from here, so
// renaming the product is a one-line change. Falls back to a neutral,
// non-invented name if no environment override is provided.
export const PRODUCT_NAME = import.meta.env.VITE_PRODUCT_NAME || 'Data Intelligence Platform';
export const PRODUCT_SHORT_NAME = import.meta.env.VITE_PRODUCT_SHORT_NAME || 'DQ Platform';
export const PRODUCT_TAGLINE = import.meta.env.VITE_PRODUCT_TAGLINE || 'Enterprise Data Quality & Master Data Intelligence';
