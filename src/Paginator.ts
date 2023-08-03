import {
  Brackets,
  ObjectType,
  OrderByCondition,
  SelectQueryBuilder,
  WhereExpressionBuilder,
} from 'typeorm';

import {
  atob,
  btoa,
  encodeByType,
  decodeByType,
  pascalToUnderscore,
} from './utils';

export enum Order {
  ASC = 'ASC',
  DESC = 'DESC',
}

export type EscapeFn = (name: string) => string;

export interface CursorParam {
  [key: string]: any;
}

export interface Cursor {
  beforeCursor: string | null;
  afterCursor: string | null;
}

export interface PagingResult<Entity> {
  data: Entity[];
  cursor: Cursor;
}

export type PaginationKeysType<Entity> =
  (Extract<keyof Entity, string> | CustomPaginationType<Entity>);

export interface CustomPaginationType<Entity> {
  select?: string;
  key: string;
  getCursorValue: (entity: Entity) => string;
}

export default class Paginator<Entity> {
  private afterCursor: string | null = null;

  private beforeCursor: string | null = null;

  private nextAfterCursor: string | null = null;

  private nextBeforeCursor: string | null = null;

  private alias: string = pascalToUnderscore(this.entity.name);

  private limit = 100;

  private order: Order = Order.DESC;

  public constructor(
    private entity: ObjectType<Entity>,
    private paginationKeys: PaginationKeysType<Entity>[],
    private paginationUniqueKey: Extract<keyof Entity, string>,
  ) {}

  public setAlias(alias: string): void {
    this.alias = alias;
  }

  public setAfterCursor(cursor: string): void {
    this.afterCursor = cursor;
  }

  public setBeforeCursor(cursor: string): void {
    this.beforeCursor = cursor;
  }

  public setLimit(limit: number): void {
    this.limit = limit;
  }

  public setOrder(order: Order): void {
    this.order = order;
  }

  public async paginate(
    builder: SelectQueryBuilder<Entity>,
  ): Promise<PagingResult<Entity>> {
    const entities = await this.appendPagingQuery(builder).getMany();
    const hasMore = entities.length > this.limit;

    if (hasMore) {
      entities.splice(entities.length - 1, 1);
    }

    if (entities.length === 0) {
      return this.toPagingResult(entities);
    }

    if (!this.hasAfterCursor() && this.hasBeforeCursor()) {
      entities.reverse();
    }

    if (this.hasBeforeCursor() || hasMore) {
      this.nextAfterCursor = this.encode(entities[entities.length - 1]);
    }

    if (this.hasAfterCursor() || (hasMore && this.hasBeforeCursor())) {
      this.nextBeforeCursor = this.encode(entities[0]);
    }

    return this.toPagingResult(entities);
  }

  private getCursor(): Cursor {
    return {
      afterCursor: this.nextAfterCursor,
      beforeCursor: this.nextBeforeCursor,
    };
  }

  private appendPagingQuery(
    builder: SelectQueryBuilder<Entity>,
  ): SelectQueryBuilder<Entity> {
    const cursors: CursorParam = {};
    const clonedBuilder = new SelectQueryBuilder<Entity>(builder);

    this.paginationKeys.forEach((item) => {
      if (typeof item !== 'string' && item.select) {
        clonedBuilder.addSelect(item.select, item.key);
      }
    });

    if (this.hasAfterCursor()) {
      Object.assign(cursors, this.decode(this.afterCursor as string));
    } else if (this.hasBeforeCursor()) {
      Object.assign(cursors, this.decode(this.beforeCursor as string));
    }

    if (Object.keys(cursors).length > 0) {
      clonedBuilder.andWhere(
        new Brackets((where) => this.buildCursorQuery(where, cursors)),
      );
    }

    clonedBuilder.take(this.limit + 1);
    clonedBuilder.orderBy(this.buildOrder());

    return clonedBuilder;
  }

  private getWhereClause(item: PaginationKeysType<Entity>): string {
    if (typeof item === 'string') {
      return `${this.alias}.${item}`;
    }
    if (!item.select) {
      return item.key;
    }
    return item.select;
  }

  private buildCursorQuery(
    where: WhereExpressionBuilder,
    cursors: CursorParam,
  ): void {
    const operator = this.getOperator();

    const isUniqueKeyPagination = this.paginationKeys.length === 1
      && this.paginationKeys[0] === this.paginationUniqueKey;

    where.andWhere(
      new Brackets((qb1) => {
        qb1.orWhere(
          new Brackets((qb2) => {
            this.paginationKeys.forEach((item) => {
              const key = typeof item === 'string' ? item : item.key;
              if (!isUniqueKeyPagination && key === this.paginationUniqueKey) {
                return;
              }
              const paramsHolder = {
                [`${key}_1`]: cursors[key],
              };
              if (cursors[key]) {
                qb2.andWhere(`${this.getWhereClause(item)} ${operator} :${key}_1`, paramsHolder);
              } else {
                qb2.andWhere(`${this.getWhereClause(item)} IS NOT NULL`);
              }
            });
          }),
        );
        if (!isUniqueKeyPagination) {
          qb1.orWhere(
            new Brackets((qb2) => {
              this.paginationKeys.forEach((item) => {
                const key = typeof item === 'string' ? item : item.key;
                const paramsHolder = {
                  [`${key}_1`]: cursors[key],
                };
                if (key === this.paginationUniqueKey) {
                  qb2.andWhere(`${this.getWhereClause(item)} ${operator} :${key}_1`, paramsHolder);
                } else if (cursors[key]) {
                  qb2.andWhere(`${this.getWhereClause(item)} = :${key}_1`, paramsHolder);
                } else {
                  qb2.andWhere(`${this.getWhereClause(item)} IS NULL`);
                }
              });
            }),
          );
        }
      }),
    );
  }

  private getOperator(): string {
    if (this.hasAfterCursor()) {
      return this.order === Order.ASC ? '>' : '<';
    }

    if (this.hasBeforeCursor()) {
      return this.order === Order.ASC ? '<' : '>';
    }

    return '=';
  }

  private buildOrder(): OrderByCondition {
    let { order } = this;

    if (!this.hasAfterCursor() && this.hasBeforeCursor()) {
      order = this.flipOrder(order);
    }

    const orderByCondition: OrderByCondition = {};
    this.paginationKeys.forEach((item) => {
      const key = typeof item === 'string' ? `${this.alias}.${item}` : item.key;
      orderByCondition[`${key}`] = order;
    });

    return orderByCondition;
  }

  private hasAfterCursor(): boolean {
    return this.afterCursor !== null;
  }

  private hasBeforeCursor(): boolean {
    return this.beforeCursor !== null;
  }

  private encode(entity: Entity): string {
    const payload = this.paginationKeys
      .map((item) => {
        if (typeof item === 'string') {
          const type = this.getEntityPropertyType(item);
          const value = encodeByType(type, entity[item]);
          return `${item}:${value}`;
        }
        const value = encodeURIComponent(item.getCursorValue(entity));
        return `${item.key}:${value}`;
      })
      .join(',');

    return btoa(payload);
  }

  private decode(cursor: string): CursorParam {
    const cursors: CursorParam = {};
    const columns = atob(cursor).split(',');
    columns.forEach((column) => {
      const [key, raw] = column.split(':');
      const type = this.getEntityPropertyType(key);
      const value = decodeByType(type, raw);
      cursors[key] = value;
    });

    return cursors;
  }

  private getEntityPropertyType(key: string): string {
    return Reflect.getMetadata(
      'design:type',
      this.entity.prototype,
      key,
    )?.name.toLowerCase() || 'string';
  }

  private flipOrder(order: Order): Order {
    return order === Order.ASC ? Order.DESC : Order.ASC;
  }

  private toPagingResult<Entity>(entities: Entity[]): PagingResult<Entity> {
    return {
      data: entities,
      cursor: this.getCursor(),
    };
  }
}
