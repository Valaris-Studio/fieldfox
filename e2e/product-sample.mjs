// product-card.pdf and product-card.png are Spanish-language renderings of this
// same card, kept as they are: the mock provider never reads attachment content,
// it answers from PRODUCT_SAMPLE.values by field name.
export const PRODUCT_SAMPLE = {
  text: 'Product name: Brisa Table. SKU: BRI-101. Brand: North Workshop. Description: Folding work table. Material: Steel. Width: 120 cm. Depth: 60 cm. Height: 75 cm. Weight: not stated.',
  values: {
    'product-name': 'Brisa Table', sku: 'BRI-101', brand: 'North Workshop',
    description: 'Folding work table.', material: 'steel',
    width: '120', depth: '60', height: '75',
  },
};
