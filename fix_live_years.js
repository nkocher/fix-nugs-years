#!/usr/bin/env osascript -l JavaScript
// fix_live_years.js — Fix year metadata for nugs.net live albums in Apple Music
//
// Usage:
//   osascript -l JavaScript fix_live_years.js                      # dry run (all built-in artists)
//   osascript -l JavaScript fix_live_years.js --commit             # apply changes
//   osascript -l JavaScript fix_live_years.js --artist "Phish"     # built-in artist (with aliases)
//   osascript -l JavaScript fix_live_years.js --artist "Orebolo"   # any artist (exact match)
//   osascript -l JavaScript fix_live_years.js --artist "A" --artist "B"  # multiple artists
//   osascript -l JavaScript fix_live_years.js --cloud-check        # also detect cloud-only tracks

// ── Output Helpers (JXA has no console.log) ─────────────────────────────────

ObjC.import('Foundation');

var _stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var _stderr = $.NSFileHandle.fileHandleWithStandardError;

function print(msg) {
  var data = $(msg + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
  _stdout.writeData(data);
}

function printErr(msg) {
  var data = $(msg + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
  _stderr.writeData(data);
}

// ── Timing ────────────────────────────────────────────────────────────────────

function timer(label) {
  var start = $.NSDate.date;
  return {
    stop: function() {
      var elapsed = -ObjC.unwrap(start.timeIntervalSinceNow);
      print('  [timer] ' + label + ': ' + elapsed.toFixed(1) + 's');
      return elapsed;
    }
  };
}

// ── Configuration ───────────────────────────────────────────────────────────

var ARTIST_ALIASES = {
  'Billy Strings': ['Billy Strings', 'Billy Strings & Friends'],
  'Goose':         ['Goose'],
  'Grateful Dead': ['Grateful Dead', 'The Grateful Dead'],
  'Phish':         ['Phish']
};

// ── Date Parsing ────────────────────────────────────────────────────────────

var DATE_PATTERNS = [
  // 1. YYYY/MM/DD — guard: first group must be 1900-2099
  { re: /^((?:19|20)\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\b/,
    extract: function(m) { return { year: +m[1], month: +m[2], day: +m[3] }; } },
  // 2. YYYY-MM-DD
  { re: /^((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/,
    extract: function(m) { return { year: +m[1], month: +m[2], day: +m[3] }; } },
  // 3. MM/DD/YYYY
  { re: /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})\b/,
    extract: function(m) { return { year: +m[3], month: +m[1], day: +m[2] }; } },
  // 4. MM/DD/YY (most common for nugs.net)
  { re: /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(\d{2})\b/,
    extract: function(m) {
      var yy = +m[3];
      return { year: (yy >= 50 ? 1900 : 2000) + yy, month: +m[1], day: +m[2] };
    } },
  // 5. MM-DD-YY
  { re: /^(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])-(\d{2})\b/,
    extract: function(m) {
      var yy = +m[3];
      return { year: (yy >= 50 ? 1900 : 2000) + yy, month: +m[1], day: +m[2] };
    } }
];

var DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

function isValidDate(y, m, d) {
  if (y < 1965 || y > 2030) return false;
  if (m < 1 || m > 12) return false;
  var maxDay = DAYS_IN_MONTH[m];
  if (m === 2 && !isLeapYear(y)) maxDay = 28;
  return d >= 1 && d <= maxDay;
}

function parseDateFromAlbum(albumName) {
  for (var i = 0; i < DATE_PATTERNS.length; i++) {
    var pat = DATE_PATTERNS[i];
    var m = albumName.match(pat.re);
    if (m) {
      var d = pat.extract(m);
      if (isValidDate(d.year, d.month, d.day)) {
        return d;
      }
    }
  }
  return null;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function buildSortAlbum(date, originalAlbum) {
  return date.year + '-' + pad2(date.month) + '-' + pad2(date.day) + ' ' + originalAlbum;
}

// ── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs(argv) {
  var opts = { commit: false, artists: [], cloudCheck: false };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit') {
      opts.commit = true;
    } else if (argv[i] === '--cloud-check') {
      opts.cloudCheck = true;
    } else if ((argv[i] === '--artist' || argv[i] === '--custom-artist') && i + 1 < argv.length) {
      var name = argv[i + 1];
      if (name) opts.artists.push(name);
      i++;
    }
  }
  // Deduplicate (case-sensitive — "Phish" and "phish" are different to Music.app)
  var seen = {};
  opts.artists = opts.artists.filter(function(a) {
    if (seen[a]) return false;
    seen[a] = true;
    return true;
  });
  return opts;
}

// ── Music.app Interaction ───────────────────────────────────────────────────

function getMusic() {
  var app = Application('Music');
  app.includeStandardAdditions = true;
  return app;
}

function preflight(music) {
  // Use index access instead of .tracks() which fetches ALL track objects
  var lib = music.libraryPlaylists[0];
  var sample = lib.tracks[0];
  if (!sample) {
    throw new Error('Music library is empty or inaccessible.');
  }
  var yr = sample.year();
  var sa = sample.sortAlbum();
  var al = sample.album();
  var ar = sample.artist();
  if (typeof yr !== 'number') throw new Error('Preflight: year is not a number');
  if (typeof al !== 'string') throw new Error('Preflight: album is not a string');
  if (typeof ar !== 'string') throw new Error('Preflight: artist is not a string');
  return true;
}

function isCloudOnlyByLocation(loc) {
  try {
    // Batch location() returns null, $.nil, or missing value for cloud tracks
    if (!loc || loc === $.nil) return true;
    var locStr = loc.toString();
    if (!locStr || locStr === 'msng' || locStr === '') return true;
    var fm = $.NSFileManager.defaultManager;
    var path = ObjC.unwrap($(locStr).stringByStandardizingPath);
    return !fm.fileExistsAtPath(path);
  } catch (e) {
    return false;  // assume local on error
  }
}

function escapeForAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t');
}

// ── Phase 1: Scan ───────────────────────────────────────────────────────────

function scanArtist(music, artistKey, aliases, cloudCheck) {
  var seen = {};
  var albums = {};
  var trackCount = 0;
  var lib = music.libraryPlaylists[0];

  for (var a = 0; a < aliases.length; a++) {
    var alias = aliases[a];
    var trackSpec;
    try {
      trackSpec = lib.tracks.whose({ artist: { _equals: alias } });
    } catch (e) { continue; }

    // Batch property reads — one Apple Event per property for ALL matching tracks
    var dbIds, albumNames, years, sortAlbums, locations;
    try {
      dbIds = trackSpec.databaseID();
      if (!dbIds || dbIds.length === 0) continue;
      albumNames = trackSpec.album();
      years = trackSpec.year();
      sortAlbums = trackSpec.sortAlbum();
    } catch (e) { continue; }

    // location() costs 1 Apple Event per alias — only read when --cloud-check is set
    if (cloudCheck) {
      try {
        locations = trackSpec.location();
      } catch (e) {
        locations = null;
      }
    }

    print('    ' + alias + ': ' + dbIds.length + ' tracks (batch read complete)');

    for (var t = 0; t < dbIds.length; t++) {
      var dbId = dbIds[t];
      if (seen[dbId]) continue;
      seen[dbId] = true;

      var albumName = albumNames[t];
      var year = years[t];
      var sortAlbum = sortAlbums[t] || '';

      if (!albums[albumName]) {
        var date = parseDateFromAlbum(albumName);
        albums[albumName] = { date: date, tracks: [], artistAlias: alias };
      }

      albums[albumName].tracks.push({
        year: year,
        sortAlbum: sortAlbum,
        dbId: dbId,
        cloudOnly: (cloudCheck && locations) ? isCloudOnlyByLocation(locations[t]) : false,
        artist: alias
      });
      trackCount++;
    }
  }

  return { albums: albums, trackCount: trackCount };
}

function buildFixPlan(albumsMap) {
  var plan = [];

  var albumNames = Object.keys(albumsMap);
  for (var i = 0; i < albumNames.length; i++) {
    var albumName = albumNames[i];
    var info = albumsMap[albumName];
    if (!info.date) continue;

    var targetYear = info.date.year;
    var targetSort = buildSortAlbum(info.date, albumName);

    var tracksToFix = [];
    var cloudSkipped = [];

    for (var t = 0; t < info.tracks.length; t++) {
      var tr = info.tracks[t];
      var needsYear = (tr.year !== targetYear);
      var needsSort = (tr.sortAlbum !== targetSort);

      if (needsYear || needsSort) {
        if (tr.cloudOnly) {
          cloudSkipped.push(tr);
        } else {
          tracksToFix.push({
            dbId: tr.dbId,
            artist: tr.artist,
            currentYear: tr.year,
            currentSort: tr.sortAlbum,
            targetYear: targetYear,
            targetSort: targetSort,
            fixYear: needsYear,
            fixSort: needsSort
          });
        }
      }
    }

    if (tracksToFix.length > 0 || cloudSkipped.length > 0) {
      plan.push({
        album: albumName,
        artistAlias: info.artistAlias,
        date: info.date,
        targetYear: targetYear,
        targetSort: targetSort,
        tracks: tracksToFix,
        cloudSkipped: cloudSkipped,
        totalInAlbum: info.tracks.length
      });
    }
  }

  plan.sort(function(a, b) {
    if (a.targetYear !== b.targetYear) return a.targetYear - b.targetYear;
    if (a.date.month !== b.date.month) return a.date.month - b.date.month;
    return a.date.day - b.date.day;
  });

  return plan;
}

// ── Display ─────────────────────────────────────────────────────────────────

function rpad(str, len) {
  while (str.length < len) str += ' ';
  return str;
}

function printPlan(plan, artistKey) {
  if (plan.length === 0) {
    print('  No fixes needed for ' + artistKey + '.');
    return;
  }

  var totalTracks = 0;
  var totalCloudSkipped = 0;

  print('');
  print('  ' + artistKey + ':');
  print('  ' + repeat('\u2500', 76));
  print('  ' + rpad('Album', 50) + rpad('Year', 12) + rpad('Tracks', 8) + 'Sort Fix');
  print('  ' + repeat('\u2500', 76));

  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    var yearCol = '';
    if (p.tracks.length > 0 && p.tracks[0].fixYear) {
      yearCol = p.tracks[0].currentYear + ' -> ' + p.targetYear;
    } else {
      yearCol = p.targetYear + ' (ok)';
    }
    var sortFix = p.tracks.some(function(t) { return t.fixSort; }) ? 'YES' : 'no';
    var albumDisplay = p.album.length > 48 ? p.album.substring(0, 45) + '...' : p.album;

    print('  ' + rpad(albumDisplay, 50) + rpad(yearCol, 12) + rpad(p.tracks.length + '', 8) + sortFix);

    totalTracks += p.tracks.length;
    totalCloudSkipped += p.cloudSkipped.length;
  }

  print('  ' + repeat('\u2500', 76));
  print('  Total: ' + plan.length + ' albums, ' + totalTracks + ' tracks to update');
  if (totalCloudSkipped > 0) {
    print('  Skipped: ' + totalCloudSkipped + ' cloud-only tracks');
  }
}

function repeat(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}

// ── Phase 1.5: Backup ──────────────────────────────────────────────────────

function writeBackup(allPlans) {
  var yearSortChanges = [];
  for (var artistKey in allPlans) {
    var plan = allPlans[artistKey];
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      for (var t = 0; t < p.tracks.length; t++) {
        var tr = p.tracks[t];
        yearSortChanges.push({
          artist: tr.artist,
          album: p.album,
          databaseID: tr.dbId,
          currentYear: tr.currentYear,
          currentSortAlbum: tr.currentSort,
          targetYear: tr.targetYear,
          targetSortAlbum: tr.targetSort
        });
      }
    }
  }

  if (yearSortChanges.length === 0) return null;

  var backupObj = { yearSortChanges: yearSortChanges };

  var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  var filename = 'itunes-year-fix-backup-' + timestamp + '.json';
  var homePath = ObjC.unwrap($.NSHomeDirectory());
  var filePath = homePath + '/.' + filename;

  var json = JSON.stringify(backupObj, null, 2);

  var nsStr = $.NSString.alloc.initWithUTF8String(json);
  var nsPath = $(filePath);
  nsStr.writeToFileAtomicallyEncodingError(nsPath, true, $.NSUTF8StringEncoding, null);

  // Set permissions to 0600 (user-only)
  var fm = $.NSFileManager.defaultManager;
  fm.setAttributesOfItemAtPathError(
    $({ NSFilePosixPermissions: 384 }),  // 0600 octal = 384 decimal
    nsPath,
    null
  );

  return filePath;
}

// ── Phase 2: Apply ──────────────────────────────────────────────────────────

function batchWriteAlbum(lib, p) {
  var albumEsc = escapeForAppleScript(p.album);
  var artistEsc = escapeForAppleScript(p.artistAlias);
  var needsYear = p.tracks.some(function(t) { return t.fixYear; });
  var needsSort = p.tracks.some(function(t) { return t.fixSort; });
  var sortEsc = needsSort ? escapeForAppleScript(p.targetSort) : '';

  var lines = ['tell application "Music"'];
  lines.push('  set theTracks to every track of library playlist 1 whose album is "' +
    albumEsc + '" and artist is "' + artistEsc + '"');
  lines.push('  repeat with aTrack in theTracks');
  if (needsYear) {
    lines.push('    set year of aTrack to ' + p.targetYear);
  }
  if (needsSort) {
    lines.push('    set sort album of aTrack to "' + sortEsc + '"');
  }
  lines.push('  end repeat');
  lines.push('end tell');
  var src = lines.join('\n');

  var errPtr = Ref();
  var script = $.NSAppleScript.alloc.initWithSource($(src));
  var result = script.executeAndReturnError(errPtr);

  if (!result) {
    var errDict = errPtr[0];
    var errMsg = 'unknown error';
    if (errDict && errDict.objectForKey) {
      var nsMsg = errDict.objectForKey($.NSAppleScriptErrorMessage);
      if (nsMsg) errMsg = ObjC.unwrap(nsMsg);
    }
    throw new Error('AppleScript batch write failed: ' + errMsg);
  }

  return p.tracks.length;
}

function perTrackWriteAlbum(lib, p) {
  var written = 0;
  for (var t = 0; t < p.tracks.length; t++) {
    var tr = p.tracks[t];
    try {
      var trackSpec = lib.tracks.whose({ databaseID: { _equals: tr.dbId } });
      var refs = trackSpec();
      if (!refs || refs.length === 0) {
        print('    WARNING: track dbId ' + tr.dbId + ' not found, skipping');
        continue;
      }
      var ref = refs[0];
      if (tr.fixYear) ref.year = tr.targetYear;
      if (tr.fixSort) ref.sortAlbum = tr.targetSort;
      written++;
    } catch (e) {
      print('    ERROR on track dbId ' + tr.dbId + ': ' + e.message);
    }
  }
  return written;
}

function applyFixes(allPlans, music) {
  var lib = music.libraryPlaylists[0];
  var totalAlbums = 0;
  var totalTracks = 0;
  var batchCount = 0;
  var fallbackCount = 0;
  var errors = [];

  for (var artistKey in allPlans) {
    var plan = allPlans[artistKey];
    print('');
    print('  Applying fixes for ' + artistKey + '...');

    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      if (p.tracks.length === 0) continue;

      var written;
      try {
        written = batchWriteAlbum(lib, p);
        totalTracks += written;
        batchCount++;
      } catch (e) {
        print('    Batch failed for "' + p.album + '": ' + e.message);
        print('    Falling back to per-track writes...');
        try {
          written = perTrackWriteAlbum(lib, p);
          totalTracks += written;
          fallbackCount++;
        } catch (e2) {
          errors.push({ album: p.album, error: e2.message });
          print('    ERROR (fallback) on "' + p.album + '": ' + e2.message);
          continue;
        }
      }
      totalAlbums++;

      if (totalAlbums % 50 === 0) {
        print('    ...updated ' + totalAlbums + ' albums (' + totalTracks + ' tracks)');
      }
    }
  }

  print('');
  print('  Done: ' + totalAlbums + ' albums, ' + totalTracks + ' tracks updated.');
  print('  Batch writes: ' + batchCount + ', per-track fallbacks: ' + fallbackCount);
  if (errors.length > 0) {
    print('  Errors: ' + errors.length + ' albums failed (see above).');
  }

  return { totalAlbums: totalAlbums, totalTracks: totalTracks, errors: errors };
}

// ── Verification ────────────────────────────────────────────────────────────

function verify(music, allPlans) {
  print('');
  print('  Verifying changes...');
  var lib = music.libraryPlaylists[0];
  var verified = 0;
  var mismatches = 0;
  var missing = 0;

  // Build expected values keyed by databaseID from all plan entries
  var expected = {};  // dbId → { targetYear, targetSort, fixYear, fixSort, album }
  var aliasesNeeded = {};  // alias → true (collect unique aliases to query)

  for (var artistKey in allPlans) {
    var plan = allPlans[artistKey];
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      if (p.tracks.length === 0) continue;
      aliasesNeeded[p.artistAlias] = true;
      for (var t = 0; t < p.tracks.length; t++) {
        var tr = p.tracks[t];
        expected[tr.dbId] = {
          targetYear: p.targetYear,
          targetSort: p.targetSort,
          fixYear: tr.fixYear,
          fixSort: tr.fixSort,
          album: p.album
        };
      }
    }
  }

  var expectedCount = Object.keys(expected).length;
  if (expectedCount === 0) {
    print('  Nothing to verify.');
    return 0;
  }

  // Query actual values per alias using single-predicate whose() — avoids _and bug
  var actual = {};  // dbId → { year, sortAlbum }
  var aliases = Object.keys(aliasesNeeded);
  for (var a = 0; a < aliases.length; a++) {
    var alias = aliases[a];
    try {
      var spec = lib.tracks.whose({ artist: { _equals: alias } });
      var dbIds = spec.databaseID();
      if (!dbIds || dbIds.length === 0) continue;
      var years = spec.year();
      var sorts = spec.sortAlbum();
      for (var j = 0; j < dbIds.length; j++) {
        if (expected[dbIds[j]]) {
          actual[dbIds[j]] = { year: years[j], sortAlbum: sorts[j] };
        }
      }
    } catch (e) {
      print('    ERROR querying artist "' + alias + '" for verify: ' + e.message);
    }
  }

  // Compare expected vs actual by databaseID
  var dbIds = Object.keys(expected);
  for (var k = 0; k < dbIds.length; k++) {
    var dbId = dbIds[k];
    var exp = expected[dbId];
    var act = actual[dbId];

    if (!act) {
      missing++;
      continue;
    }

    var yearOk = !exp.fixYear || act.year === exp.targetYear;
    var sortOk = !exp.fixSort || act.sortAlbum === exp.targetSort;

    if (yearOk && sortOk) {
      verified++;
    } else {
      mismatches++;
      if (mismatches <= 10) {
        print('    MISMATCH: dbId ' + dbId + ' in "' + exp.album + '"');
        if (!yearOk) print('      year: expected ' + exp.targetYear + ', got ' + act.year);
        if (!sortOk) print('      sortAlbum: expected "' + exp.targetSort + '", got "' + act.sortAlbum + '"');
      }
    }
  }

  print('  Verified: ' + verified + ' tracks OK, ' + mismatches + ' mismatches.');
  if (missing > 0) {
    print('  ' + missing + ' tracks not found (may be cloud-only or deleted)');
  }
  if (mismatches > 10) {
    print('  (Showing first 10 mismatches only)');
  }
  return mismatches + missing;
}

// ── Main ────────────────────────────────────────────────────────────────────

function run(argv) {
  var opts = parseArgs(argv);

  print('================================================================');
  print('  fix_live_years.js -- Fix nugs.net year metadata');
  var modeLabel = opts.commit ? 'COMMIT (will write changes)' : 'DRY RUN (read-only)';
  if (opts.cloudCheck) modeLabel += ' +cloud-check';
  print('  Mode: ' + modeLabel);
  print('================================================================');
  print('');

  // Determine target artists
  var targetArtists = {};
  if (opts.artists.length > 0) {
    for (var ai = 0; ai < opts.artists.length; ai++) {
      var name = opts.artists[ai];
      // Case-insensitive lookup in built-in aliases
      var matched = false;
      var nameLower = name.toLowerCase();
      for (var key in ARTIST_ALIASES) {
        if (key.toLowerCase() === nameLower) {
          targetArtists[key] = ARTIST_ALIASES[key];
          matched = true;
          break;
        }
      }
      if (!matched) {
        print('  "' + name + '" not in built-in aliases; using exact match.');
        targetArtists[name] = [name];
      }
    }
  } else {
    targetArtists = ARTIST_ALIASES;
  }

  // Connect to Music.app
  var tTotal = timer('total');
  print('  Connecting to Music.app...');
  var music = getMusic();

  // Preflight
  var tPre = timer('preflight');
  print('  Running preflight checks...');
  try {
    preflight(music);
    print('  Preflight OK.');
  } catch (e) {
    print('  PREFLIGHT FAILED: ' + e.message);
    print('  Make sure Music.app is open and has tracks in the library.');
    return;
  }
  tPre.stop();

  // Phase 1: Scan
  var tScan = timer('scan + fix plan');
  print('');
  print('  Scanning library...');
  var allPlans = {};
  var grandTotalTracks = 0;

  for (var artistKey in targetArtists) {
    print('  Scanning ' + artistKey + '...');
    var result = scanArtist(music, artistKey, targetArtists[artistKey], opts.cloudCheck);
    print('    Found ' + result.trackCount + ' tracks across ' + Object.keys(result.albums).length + ' albums');

    var plan = buildFixPlan(result.albums);
    allPlans[artistKey] = plan;
    printPlan(plan, artistKey);
    grandTotalTracks += result.trackCount;
  }
  tScan.stop();

  // Summary
  var totalFixAlbums = 0;
  var totalFixTracks = 0;
  var totalCloudSkipped = 0;
  for (var ak in allPlans) {
    for (var j = 0; j < allPlans[ak].length; j++) {
      totalFixAlbums++;
      totalFixTracks += allPlans[ak][j].tracks.length;
      totalCloudSkipped += allPlans[ak][j].cloudSkipped.length;
    }
  }

  print('');
  print('  =========================================');
  print('  SUMMARY:');
  print('  Year/sort: ' + totalFixAlbums + ' albums, ' + totalFixTracks + ' tracks need fixes');
  if (totalCloudSkipped > 0) {
    print('  (plus ' + totalCloudSkipped + ' cloud-only tracks skipped)');
  }
  print('  =========================================');

  if (totalFixTracks === 0) {
    print('  Nothing to fix!');
    return;
  }

  if (!opts.commit) {
    print('');
    print('  This was a DRY RUN. To apply changes, run with --commit');
    return;
  }

  // Phase 1.5: Backup
  var tBackup = timer('backup');
  print('');
  print('  Writing backup...');
  var backupPath = writeBackup(allPlans);
  if (backupPath) {
    print('  Backup saved to: ' + backupPath);
  }
  tBackup.stop();

  // Phase 2: Confirm & Apply
  print('');
  print('  WARNING: About to apply changes. Do NOT sync iCloud Music Library during this process.');
  print('');

  var dialogParts = ['fix_live_years.js will update:',
    '  \u2022 ' + totalFixAlbums + ' albums (' + totalFixTracks + ' tracks) \u2014 year/sort',
    '',
    'Backup saved to:',
    backupPath,
    '',
    'Do NOT sync iCloud Music Library during this process.',
    '',
    'Click OK to proceed or Cancel to abort.'];

  var currentApp = Application.currentApplication();
  currentApp.includeStandardAdditions = true;
  try {
    currentApp.displayDialog(
      dialogParts.join('\n'),
      { withTitle: 'Confirm Fixes', buttons: ['Cancel', 'OK'], defaultButton: 'OK' }
    );
  } catch (e) {
    print('  Aborted by user.');
    return;
  }

  // Apply year/sort
  var tApply = timer('apply');
  var applyResult = applyFixes(allPlans, music);
  tApply.stop();

  // Verify year/sort
  var tVerify = timer('verify');
  var mismatches = verify(music, allPlans);
  tVerify.stop();

  tTotal.stop();
  print('');
  if (mismatches === 0 && applyResult.errors.length === 0) {
    print('  All changes verified successfully.');
  } else {
    print('  WARNING: Some issues detected -- review output above.');
    if (backupPath) {
      print('  Backup available at: ' + backupPath);
    }
  }
}
