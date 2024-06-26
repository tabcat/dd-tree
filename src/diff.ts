/**
 * implements efficient prolly-tree diff https://www.dolthub.com/blog/2020-06-16-efficient-diff-on-prolly-trees/
 * article by Aaron Son, June 16, 2020
 *
 * (code, comments) have been scraped from the article and turned into (typescript, jsdoc) format.
 */

import { ithElement } from "@tabcat/ith-element";
import { Blockstore } from "interface-blockstore";
import type { CID } from "multiformats/cid";
import { compareTuples } from "./compare.js";
import { createCursor, type Cursor } from "./cursor.js";
import { Bucket, Node, ProllyTree } from "./interface.js";

/**
 * Advances left and right cursors until one of them is done or they are no longer equal.
 * Postcondition:
 *   left.done() || right.done() ||
 *   compareTuples(left.current(), right.current()) !== 0
 *
 */
async function fastForwardUntilUnequal<Code extends number, Alg extends number>(
  left: Cursor<Code, Alg>,
  right: Cursor<Code, Alg>,
): Promise<void> {
  while (!left.done() && !right.done()) {
    if (compareTuples(left.current(), right.current()) !== 0) {
      return;
    }

    const level = greatestMatchingLevelForPaths(left.path(), right.path());

    await Promise.all([
      left.nextAtLevel(level + 1),
      right.nextAtLevel(level + 1),
    ]);
  }
}

/**
 * Returns the highest level in the tree at which the provided paths match.
 * Returns -1 if there is no chunk address that matches, 0 if only the last
 * chunk address in each path matches, etc.
 *
 * @param left - buckets from root to leaf bucket
 * @param right - buckets from root to leaf bucket
 * @returns
 */
function greatestMatchingLevelForPaths(left: CID[], right: CID[]): number {
  let level = -1;
  let li = left.length - 1;
  let ri = right.length - 1;

  while (li >= 0 && ri >= 0) {
    if (!ithElement(left, li).equals(ithElement(right, ri))) {
      break;
    }

    li--;
    ri--;
    level++;
  }

  return level;
}

type LeftDiff<T> = [T, null];
type RightDiff<T> = [null, T];
type LeftAndRightDiff<T> = [T, T];

const leftDiffer = <Code extends number, Alg extends number>(
  bucket: Bucket<Code, Alg>,
): LeftDiff<Bucket<Code, Alg>> => [bucket, null];
const rightDiffer = <Code extends number, Alg extends number>(
  bucket: Bucket<Code, Alg>,
): RightDiff<Bucket<Code, Alg>> => [null, bucket];

type Diff<T> = LeftDiff<T> | RightDiff<T> | LeftAndRightDiff<T>;

export type NodeDiff = Diff<Node>;
export type BucketDiff<Code extends number, Alg extends number> = Diff<
  Bucket<Code, Alg>
>;

export interface ProllyTreeDiff<Code extends number, Alg extends number> {
  nodes: NodeDiff[];
  buckets: BucketDiff<Code, Alg>[];
}

export const createProllyTreeDiff = <
  Code extends number,
  Alg extends number,
>(): ProllyTreeDiff<Code, Alg> => ({
  nodes: [],
  buckets: [],
});

const getBucketCID = <Code extends number, Alg extends number>(
  b: Bucket<Code, Alg>,
): CID => b.getCID();

const getUnmatched = <Code extends number, Alg extends number>(
  last: Bucket<Code, Alg>[],
  current: Bucket<Code, Alg>[],
): Bucket<Code, Alg>[] =>
  last.slice(
    -greatestMatchingLevelForPaths(
      last.map(getBucketCID),
      current.map(getBucketCID),
    ) - 1,
  );

export async function* diff<Code extends number, Alg extends number>(
  blockstore: Blockstore,
  left: ProllyTree<Code, Alg>,
  right: ProllyTree<Code, Alg>,
  rightBlockstore?: Blockstore,
): AsyncIterable<ProllyTreeDiff<Code, Alg>> {
  let d = createProllyTreeDiff<Code, Alg>();
  const leftCursor: Cursor<Code, Alg> = createCursor(blockstore, left);
  const rightCursor: Cursor<Code, Alg> = createCursor(
    rightBlockstore ?? blockstore,
    right,
  );
  let lastLeftBuckets: Bucket<Code, Alg>[];
  let lastRightBuckets: Bucket<Code, Alg>[];

  // i've written this function in ordered-sets, just have to generalize again
  while (!leftCursor.done() && !rightCursor.done()) {
    const [lv, rv] = [leftCursor.current(), rightCursor.current()];

    if (compareTuples(lv, rv) > 0) {
      // add node to diff
      d.nodes.push([lv, null]);

      // add buckets to diff
      lastLeftBuckets = leftCursor.buckets();
      await leftCursor.next();
      d.buckets.push(
        ...getUnmatched(lastLeftBuckets, leftCursor.buckets()).map(leftDiffer),
      );
    } else if (compareTuples(lv, rv) < 0) {
      // add node to diff
      d.nodes.push([null, rv]);

      // add buckets to diff
      lastRightBuckets = rightCursor.buckets();
      await rightCursor.next();
      d.buckets.push(
        ...getUnmatched(lastRightBuckets, rightCursor.buckets()).map(
          rightDiffer,
        ),
      );
    } else {
      await fastForwardUntilUnequal(leftCursor, rightCursor);
    }

    // yield diff as bucket changes
    if (d.buckets.length > 0) {
      yield d;
      d = createProllyTreeDiff();
    }
  }

  while (!leftCursor.done()) {
    // add node to diff
    d.nodes.push([leftCursor.current(), null]);

    // add buckets to diff
    lastLeftBuckets = leftCursor.buckets();
    await leftCursor.next();
    d.buckets.push(
      ...getUnmatched(lastLeftBuckets, leftCursor.buckets()).map(leftDiffer),
    );

    // yield diff as bucket changes
    if (d.buckets.length > 0) {
      yield d;
      d = createProllyTreeDiff();
    }
  }

  while (!rightCursor.done()) {
    d.nodes.push([null, rightCursor.current()]);

    // add buckets to diff
    lastRightBuckets = rightCursor.buckets();
    await rightCursor.next();
    d.buckets.push(
      ...getUnmatched(lastRightBuckets, rightCursor.buckets()).map(rightDiffer),
    );

    // yield diff as bucket changes
    if (d.buckets.length > 0) {
      yield d;
      d = createProllyTreeDiff();
    }
  }
}
