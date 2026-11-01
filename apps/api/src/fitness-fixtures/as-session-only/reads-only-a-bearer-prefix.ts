/** Planted: a route handler slicing off a scheme it was handed. */
export const strip = (raw: string): string => raw.replace('Bearer ', '');
