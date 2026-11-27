import type { DelegateView } from '../DelegationHud.tsx';

// Item-wise identity comparison, so App can keep handing a pane the SAME delegates array while nothing in it changed
// (the list is rebuilt every second because it depends on the `now` tick for the linger window).
export function sameDelegates(a: readonly DelegateView[], b: readonly DelegateView[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.task === y.task && x.session === y.session && x.activity === y.activity && x.state === y.state;
  });
}
