import { isFolderSpace } from './data.js';
import { WorkspaceRecords, diffFields } from './workspace-records.js';

const skip = new Set(['spaces', 'version']);
const folderLink = ({name, folder, encrypted}) => ({name, folder, encrypted});
function entry(space, live) {
  return isFolderSpace(space)
    ? {link: JSON.stringify(folderLink(space))}
    : {records: new WorkspaceRecords(space), live};
}

export class CatalogRecords {
  constructor(snapshot, live) {
    this.fields = new Map();
    diffFields(this.fields, snapshot, undefined, skip).commit();
    this.version = snapshot.version;
    this.live = live;
    this.spaces = new Map(Object.entries(snapshot.spaces).map(([id, space]) => [id, entry(space, live.spaces[id])]));
    this.settings = new Set();
    this.generation = 0;
    this.allSettings = false;
  }
  markSettings(keys) {
    this.generation++;
    for (const key of keys) this.settings.add(key);
  }
  markSpace(id, scope) {
    this.spaces.get(id)?.records?.mark(scope);
  }
  markAll() {
    this.allSettings = true;
    this.generation++;
    for (const saved of this.spaces.values()) saved.records?.mark();
  }
  prepare(catalog) {
    const structural = this.live !== catalog, generation = this.generation;
    const fields = diffFields(this.fields, catalog, structural || this.allSettings ? undefined : this.settings, skip);
    const patch = fields.patch, commits = [fields.commit], spaces = Object.create(null);
    let version3 = catalog.version === 3 || !catalog.spaces.personal || !!catalog.demoHidden;
    let sealed = false;
    for (const [id, space] of Object.entries(catalog.spaces)) {
      const before = this.spaces.get(id), folder = isFolderSpace(space);
      if (folder || (id !== 'personal' && id !== 'demo')) version3 = true;
      if (!before || folder !== ('link' in before)) {
        const replace = folder ? folderLink(space) : JSON.parse(JSON.stringify(space));
        spaces[id] = {replace};
        const next = entry(replace, space);
        // The new entry is only indexed after the acknowledgement. Catch edits
        // made to its live records while this replacement was in flight.
        next.records?.mark();
        if (next.records?.sealed.size) sealed = true;
        commits.push(() => this.spaces.set(id, next));
      } else if (folder) {
        const link = folderLink(space), raw = JSON.stringify(link);
        if (raw !== before.link) {
          spaces[id] = {replace: link};
          commits.push(() => { before.link = raw });
        }
      } else {
        if (before.live !== space) before.records.mark();
        const draft = before.records.prepare(space);
        if (draft.hasSealedNotes) sealed = true;
        if (draft.patch) spaces[id] = draft.patch;
        commits.push(() => { draft.commit(); before.live = space });
      }
    }
    for (const id of this.spaces.keys()) {
      if (Object.hasOwn(catalog.spaces, id)) continue;
      spaces[id] = {remove: true};
      commits.push(() => this.spaces.delete(id));
    }
    if (Object.keys(spaces).length) patch.spaces = spaces;
    const version = version3 ? 3 : sealed ? 2 : 1;
    if (this.version !== version) (patch.set ??= Object.create(null)).version = version;
    return {patch: Object.keys(patch).length ? patch : null, commit: () => {
      for (const apply of commits) apply();
      this.live = catalog;
      this.version = version;
      if (this.generation === generation) {
        this.allSettings = false;
        this.settings.clear();
      }
    }};
  }
}
