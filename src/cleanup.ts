import {
  Observable,
  Observer,
  Subject,
  Subscription
} from 'rxjs';
import {
  takeUntil,
  takeWhile,
  startWith,
  map,
  filter,
  catchError
} from 'rxjs/operators';
import {
  Change
} from './lib/asyncUtils';
import { setTimeout } from 'timers/promises';

import {
  baseLogger as baseLogger,
  LoggerMetadata,
  ppObj
} from './services/baseLogger';
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
  baseLogger.debug(`observer change: ${change.type} ${change.elt}`, {
    context: baseLogger.defaultMeta!.context,
    change
  });
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
  inputObservableLogger.debug(`registered input observable ${metadata.context}`, metadata);
  return (observable: Observable<T>): Observable<T> => {
    const out = observable.pipe(takeUntil(flushInputs));
    createObserverTarget(out, metadata, { complete: () => inputObservableLogger.debug(`Completed input observable ${metadata.context}`) });
    return out;
  };
}

export async function tryToFlushInputObservables(): Promise<boolean> {
  const logger = baseLogger.child({ context: 'tryToFlushInputObservables' });
  logger.info('attempting graceful shutdown...');
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
    logger.debug(`Active observers after flush attempt: ${getObserverCountRepr()}`);
    return false;
  }
}
