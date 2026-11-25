import { findNoteMatches } from './note-find-matches.js';

self.onmessage = ({data}) => self.postMessage(findNoteMatches(data.records, data.options, data.ranges));
