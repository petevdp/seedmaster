import { concat, from, Observable } from 'rxjs';
import {
  share,
  mergeAll,
  map
} from 'rxjs/operators';
import { createObserverTarget } from '../cleanup';
import {
  accumulateMap,
  auditChanges,
  Change, changeOfType, flattenDeferred,
  isDeferred, mapChange,
  toChange
} from './asyncUtils';
import { filter, first, mapTo, startWith, withLatestFrom } from './rxOperators';

export type GetKey<K, T> = (elt: T) => K;
export type IndexCollection<L extends string, K, T> = Record<L, GetKey<K, T>>

// export interface EntityStore<L extends string, K, T> {
//   state: Record<L, Map<K, T>>;
//   change$: Observable<Change<T>>;
// }

export type PossiblyDeferred<T> = T | Promise<T>;

/**
 * Creates a store with a set of unique indexes to look up values from.
 * When change$ emits, the emitted change is guaranteed to have affected the state of the store
 * @param change$
 * @param indexes
 * @param storeLabel
 */
// export function createEntityStore<L extends string, K, T>(change$: Observable<Change<T>>, indexes: IndexCollection<L, K, T>, storeLabel: string) {
//   return new EntityStore(change$, indexes, storeLabel);
// }

export function processAllEntities<T>(store: PossiblyDeferred<EntityStore<string, unknown, T>>): Observable<Change<T>> {
  if (isDeferred(store)) {
    return flattenDeferred(store.then(store => {
      const out = processAllEntities(store);
      return out;
    }));
  }

  // wrap accessing store.state in cold observable so the caller gets up-to-date values on subscription
  // const existing$ = new Observable<T>((s) => {
  //   const existing = [...Object.values(store.state)[0].values()];
  //   for (let elt of existing) {
  //     s.next(elt);
  //   }
  // }).pipe(map(toChange('added')));
  const existing = [...Object.values(store.state)[0].values()] as T[];
  return concat(
    from(existing).pipe(map(toChange('added'))),
    store.change$
  );
}


export class EntityStore<L extends string, K, T> {
  change$: Observable<Change<T>>;
  state: Record<L, Map<K, T>>;

  // constructor(store: EntityStore<L, K, T>, private indexes: IndexCollection<L, K, T>) {
  public primaryIndex: L;

  constructor(change$: Observable<Change<T>>, public indexes: IndexCollection<L, K, T>, public storeLabel: string) {
    this.primaryIndex = Object.keys(indexes)[0] as L;
    const changeShared$ = change$.pipe(share());
    this.change$ = changeShared$;
    const state = {} as Partial<typeof this.state>;

    for (let [keyLabel, getKey] of Object.entries(indexes)) {
      const map = new Map<K, T>();
      let getKeyTyped = getKey as GetKey<K, T>;
      createObserverTarget(changeShared$.pipe(auditChanges(getKeyTyped)), { context: `entity-${storeLabel}-${keyLabel}` }, { next: accumulateMap(map, getKeyTyped) });
      state[keyLabel as L] = map;
    }
    this.state = state as typeof this.state;
  }

  trackAllEntities(): Observable<Change<T>> {
    const existing = [...(Object.values(this.state)[0] as Map<K, T>).values()];
    return concat(
      from(existing).pipe(map(toChange('added'))),
      this.change$
    );
  }

  setPrimaryIndex(label: L): EntityStore<L, K, T> {
    this.primaryIndex = label
    return this;
  }

  get entries(): T[] {
    return [...this.state[this.primaryIndex].values()];
  }

  trackAsList(): Observable<T[]> {
    return this.trackAllEntities().pipe(map(() => this.entries));
  }

  trackEntity(key: K, label: L = this.primaryIndex): Observable<Change<T>> {
    const getKey = this.indexes[label];
    let change$ = this.change$.pipe(filter((change) => getKey(change.elt) === key));
    const existing$ = new Observable<T>((sub) => {
      const existing = this.state[label].get(key);
      if (existing) sub.next(existing);
      sub.complete();
    }).pipe(map(toChange('added')));

    return concat(
      existing$,
      change$
    );
  }

  trackEntityEvent(key: K, eventType: Change<T>['type'], label: L = this.primaryIndex): Promise<T | undefined> {
    return this.trackEntity(key, label).pipe(changeOfType(eventType), first()).toPromise();
  }
}
