import {
  BehaviorSubject,
  Observable,
  Observer,
  PartialObserver,
  Subject,
  Subscription,
  Unsubscribable
} from 'rxjs';
import {
  mapTo,
  takeUntil,
  takeWhile,
  startWith,
  map,
  filter,
  tap,
  catchError,
  endWith
} from 'rxjs/operators';
import {
  auditChanges,
  Change,
  scanChangesToMap,
  scanChangesToSet
} from './lib/asyncUtils';
import { setTimeout } from 'timers/promises';
import { v4 as uuidv4 } from 'uuid';

import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';
import {
  logger as baseLogger,
  LoggerMetadata,
  ppObj
} from './globalServices/logger';
import secondsToMilliseconds from 'date-fns/secondsToMilliseconds';
import { Future } from './lib/future';
import { isNonNulled } from './lib/typeUtils';

const flushInputs = new Future<void>();

const masterSub: Subscription = new Subscription();


const observerLabel = new Subject<Change<string>>();
const observerCountsMap$ = new Subject<Map<string, number>>();
const observerCountsMap = new Map<string, number>();
const observerCount$ = observerCountsMap$.pipe(map(getObserverCount));

function getObserverCount(map: Map<string, number>) {
  return [...map.values()].reduce((sum, val) => sum + val);
}

observerLabel
  .pipe(
    map(change => {
      if (change.type === 'added' && observerCountsMap.has(change.elt)) {
        observerCountsMap.set(change.elt, (observerCountsMap.get(change.elt) as number) + 1);
        return observerCountsMap;
      }
      if (change.type === 'added' && !observerCountsMap.has(change.elt)) {
        observerCountsMap.set(change.elt, 1);
        return observerCountsMap;
      }
      if (change.type === 'removed' && observerCountsMap.has(change.elt)) {
        observerCountsMap.set(change.elt, (observerCountsMap.get(change.elt) as number) - 1);
        return observerCountsMap;
      }
      return null;
    }),
    filter(isNonNulled)
  )
  .subscribe(observerCountsMap$);


observerLabel.subscribe(change => {
  baseLogger.info(`observer change: ${change.type} ${change.elt}`, { change });
});

type ObserverNoError<T> = Omit<Partial<Observer<T>>, 'error'>;

/**
 * create a subscription with the given observable/observer that is targeted as needing to have completed during the flush process
 */
export function createObserverTarget<T>(observable: Observable<T>, meta: LoggerMetadata, observer: Partial<Observer<T>> | null = null) {
  let labelWithDefault = meta.context ?? 'anonymous';
  observerLabel.next({ type: 'added', elt: labelWithDefault });
  const errorHandledObservable = observable.pipe(
    catchError((err, o) => {
      baseLogger.error(err, { ...meta, category: 'masterSub' });
      // ensure we remove entries where the source observable completes
      throw err;
    })
  );
  masterSub.add(errorHandledObservable.subscribe({
    complete: () => {
      observer?.complete && observer.complete();
      observerLabel.next({ type: 'removed', elt: labelWithDefault });
    },
    next: (elt) => observer?.next && observer.next(elt),
    error: err => {
      if (observer?.error) observer.error(err);
      else throw err;
    }
  }));
}


export function getObserverCountRepr(): string {
  const obj: any = {};
  for (let [label, count] of observerCountsMap.entries())
    obj[label] = count;
  return ppObj(obj);
}

export function getObserverCountRepr$(): Observable<string> {
  return observerCountsMap$.pipe(map(getObserverCountRepr));
}

export function registerInputObservable<T>(metadata: LoggerMetadata) {
  const inputObservableLogger = baseLogger.child({
    context: metadata.context,
    category: 'inputObservable'
  });
  inputObservableLogger.info(`registered input observable ${metadata.context}`, metadata);
  return (observable: Observable<T>): Observable<T> => {
    const out = observable.pipe(takeUntil(flushInputs));
    createObserverTarget(out, metadata, { complete: () => inputObservableLogger.info(`Completed input observable ${metadata.context}`) });
    return out;
  };
}

export async function tryToFlushInputObservables(): Promise<boolean> {
  const logger = baseLogger.child({ context: 'tryToFlushInputObservables' });
  logger.info('attempting to flush streams, winding down...');
  flushInputs.resolve();

  const leftAfterTimeout = await observerCount$
    .pipe(
      startWith(getObserverCount(observerCountsMap)),
      takeWhile(count => count !== 0),
      takeUntil(setTimeout(secondsToMilliseconds(5)))
    ).toPromise() as number;

  if (leftAfterTimeout > 0) {

    logger.info('successfully flushed all streams');
    return true;
  } else {
    logger.warn(`flush attempt timed out, (${leftAfterTimeout} observables left)`);
    logger.warn(`Active observers after flush attempt: ${getObserverCountRepr()}`);
    return false;
  }
}
