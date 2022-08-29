import {
  BehaviorSubject,
  Observable,
  Observer,
  PartialObserver,
  Subject,
  Subscription,
  Unsubscribable
} from 'rxjs';
import { mapTo, takeUntil, filter } from 'rxjs/operators';
import { Future } from './asyncUtils';
import { setTimeout } from 'timers/promises';

import minutesToMilliseconds from 'date-fns/minutesToMilliseconds';

const flush$ = new Future<void>();
const masterSubject = new Subject<any>();

const masterSub: Subscription = new Subscription();

export function registerInputObservable<T>() {
  return (observable: Observable<T>): Observable<T> => {
    const out = observable.pipe(takeUntil(flush$));
    out.subscribe(masterSubject);
    return out;
  };
}

export function tryToFlushInputObservables(): Promise<void> {
  flush$.resolve();
  const abortTime = setTimeout(minutesToMilliseconds(15));
  return subRefCount
    .pipe(
      filter(refCount => refCount === 0),
      mapTo(undefined),
      takeUntil(abortTime)
    )
    .toPromise();
}

let subRefCount = new BehaviorSubject<number>(0);

export function addSubToMaster<T>(o: Observable<T>, observer: Partial<Observer<T>> | null = null) {
  subRefCount.next(subRefCount.value + 1);
  masterSub.add(o.subscribe({
    complete: () => {
      observer?.complete && observer.complete();
      subRefCount.next(subRefCount.value - 1);
    },
    next: (elt) => observer?.next && observer.next(elt),
    error: err => observer?.error && observer.error(err)
  }));
}
