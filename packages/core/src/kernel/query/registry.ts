/**
 * Defines a relation from a parent entity to a related entity.
 * Used by the query executor to batch-load related records.
 */
export interface RelationDefinition {
  foreignKey: string;
  targetService: string;
  batchMethod: string;
  attachAs: string;
  isList?: boolean;
}

/**
 * Defines an entity that can be queried via kernel.query().
 */
export interface EntityDefinition {
  service: string;
  getByIdMethod: string;
  listMethod: string;
  relations: Record<string, RelationDefinition>;
}

/**
 * Registry of queryable entities and their relations.
 * Modules register their entities at kernel boot.
 * Plugins can register additional entities.
 */
export class QueryRegistry {
  private entities = new Map<string, EntityDefinition>();

  register(name: string, definition: EntityDefinition): void {
    this.entities.set(name, definition);
  }

  get(name: string): EntityDefinition | undefined {
    return this.entities.get(name);
  }

  has(name: string): boolean {
    return this.entities.has(name);
  }

  listEntities(): string[] {
    return [...this.entities.keys()];
  }
}
