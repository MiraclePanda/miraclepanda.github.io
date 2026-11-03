// 区間データの一覧。旅の位置(position.segmentId)からひく。
import { ATAMI_ITO } from './atamiIto.js';

export const SEGMENTS = { [ATAMI_ITO.id]: ATAMI_ITO };

export function getSegment(id) {
  return SEGMENTS[id] ?? null;
}
