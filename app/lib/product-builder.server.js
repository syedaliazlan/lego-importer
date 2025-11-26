
// product-builder.server.js
export function buildSetProduct(setData, defaults) {
  return {
    product: {
      title: `LEGO ${setData.set_num} – ${setData.name}`,
      vendor: defaults.vendor,
      product_type: defaults.typeSet,
      status: defaults.status,
      images: (setData.set_img_url ? [{ src: setData.set_img_url }] : []),
    },
  };
}

export function buildPartProduct(partData, defaults) {
  return {
    product: {
      title: `LEGO Part ${partData.part_num} – ${partData.name}`,
      vendor: defaults.vendor,
      product_type: defaults.typePart,
      status: defaults.status,
      images: (partData.part_img_url ? [{ src: partData.part_img_url }] : []),
    },
  };
}
