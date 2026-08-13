/**
 * The other direction: a module the enumerated list claims is an **authoring**
 * surface, carrying no key at all. An editor that silently stopped carrying
 * the answer is a different defect from one that leaked it, and a
 * one-directional check says nothing about it (DEC-4 condition 2).
 */
export interface PlantedAuthoringItemDto {
  readonly itemVersionId: string;
  readonly stemPlainText: string;
}
