#!/usr/bin/env osascript -l JavaScript
// fix_live_years.js — Fix year metadata for nugs.net live albums in Apple Music
//
// Usage:
//   osascript -l JavaScript fix_live_years.js                      # dry run
//   osascript -l JavaScript fix_live_years.js --commit             # apply
//   osascript -l JavaScript fix_live_years.js --artist "Phish"     # single artist

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

// ── Configuration ───────────────────────────────────────────────────────────

var ARTIST_ALIASES = {
  'Billy Strings': ['Billy Strings', 'Billy Strings & Friends'],
  'Goose':         ['Goose'],
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
  var opts = { commit: false, artistFilter: null, customArtist: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--commit') {
      opts.commit = true;
    } else if (argv[i] === '--artist' && i + 1 < argv.length) {
      opts.artistFilter = argv[i + 1];
      i++;
    } else if (argv[i] === '--custom-artist' && i + 1 < argv.length) {
      opts.customArtist = argv[i + 1];
      i++;
    }
  }
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

function isCloudOnly(track) {
  try {
    var loc = track.location();
    if (!loc) return true;
    var fm = $.NSFileManager.defaultManager;
    var path = ObjC.unwrap($(loc.toString()).stringByStandardizingPath);
    return !fm.fileExistsAtPath(path);
  } catch (e) {
    return false;
  }
}

// ── Phase 1: Scan ───────────────────────────────────────────────────────────

function scanArtist(music, artistKey, aliases) {
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
    var dbIds, albumNames, years, sortAlbums, trackNames;
    try {
      dbIds = trackSpec.databaseID();
      if (!dbIds || dbIds.length === 0) continue;
      albumNames = trackSpec.album();
      years = trackSpec.year();
      sortAlbums = trackSpec.sortAlbum();
      trackNames = trackSpec.name();
    } catch (e) { continue; }

    // We also need track references for the write phase
    var trackRefs = trackSpec();

    print('    ' + alias + ': ' + dbIds.length + ' tracks (batch read complete)');

    for (var t = 0; t < dbIds.length; t++) {
      var dbId = dbIds[t];
      if (seen[dbId]) continue;
      seen[dbId] = true;

      var albumName = albumNames[t];
      var year = years[t];
      var sortAlbum = sortAlbums[t] || '';
      var trackName = trackNames[t];

      // Cloud-only check — still per-track but only for tracks we'll write to
      // Defer to build phase to avoid unnecessary IPC here

      if (!albums[albumName]) {
        var date = parseDateFromAlbum(albumName);
        albums[albumName] = { date: date, tracks: [] };
      }

      albums[albumName].tracks.push({
        ref: trackRefs[t],
        year: year,
        sortAlbum: sortAlbum,
        name: trackName,
        dbId: dbId,
        cloudOnly: false,  // Checked lazily during fix plan
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
      var hasValidSort = tr.sortAlbum && /^\d{4}-\d{2}-\d{2} /.test(tr.sortAlbum);
      var needsSort = !hasValidSort;

      if (needsYear || needsSort) {
        // Lazy cloud-only check — only for tracks that need fixing
        var cloudOnly = false;
        try { cloudOnly = isCloudOnly(tr.ref); } catch (e) { /* assume local */ }
        if (cloudOnly) {
          cloudSkipped.push(tr);
        } else {
          tracksToFix.push({
            ref: tr.ref,
            name: tr.name,
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
  var backup = [];
  for (var artistKey in allPlans) {
    var plan = allPlans[artistKey];
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      for (var t = 0; t < p.tracks.length; t++) {
        var tr = p.tracks[t];
        backup.push({
          artist: tr.artist,
          album: p.album,
          trackName: tr.name,
          databaseID: tr.dbId,
          currentYear: tr.currentYear,
          currentSortAlbum: tr.currentSort,
          targetYear: tr.targetYear,
          targetSortAlbum: tr.targetSort
        });
      }
    }
  }

  if (backup.length === 0) return null;

  var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  var filename = 'itunes-year-fix-backup-' + timestamp + '.json';
  var homePath = ObjC.unwrap($.NSHomeDirectory());
  var filePath = homePath + '/.' + filename;

  var json = JSON.stringify(backup, null, 2);

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

function applyFixes(allPlans) {
  var totalAlbums = 0;
  var totalTracks = 0;
  var errors = [];

  for (var artistKey in allPlans) {
    var plan = allPlans[artistKey];
    print('');
    print('  Applying fixes for ' + artistKey + '...');

    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      try {
        for (var t = 0; t < p.tracks.length; t++) {
          var tr = p.tracks[t];
          if (tr.fixYear) {
            tr.ref.year = tr.targetYear;
          }
          if (tr.fixSort) {
            tr.ref.sortAlbum = tr.targetSort;
          }
          totalTracks++;
        }
        totalAlbums++;

        if (totalAlbums % 50 === 0) {
          print('    ...updated ' + totalAlbums + ' albums (' + totalTracks + ' tracks)');
        }
      } catch (e) {
        errors.push({ album: p.album, error: e.message });
        print('    ERROR on "' + p.album + '": ' + e.message);
      }
    }
  }

  print('');
  print('  Done: ' + totalAlbums + ' albums, ' + totalTracks + ' tracks updated.');
  if (errors.length > 0) {
    print('  Errors: ' + errors.length + ' albums failed (see above).');
  }

  return { totalAlbums: totalAlbums, totalTracks: totalTracks, errors: errors };
}

// ── Verification ────────────────────────────────────────────────────────────

function verify(music, allPlans) {
  print('');
  print('  Verifying changes...');
  var mismatches = 0;
  var verified = 0;

  for (var artistKey in allPlans) {
    var plan = allPlans[artistKey];
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      for (var t = 0; t < p.tracks.length; t++) {
        var tr = p.tracks[t];
        try {
          var actualYear = tr.ref.year();
          var actualSort = tr.ref.sortAlbum() || '';

          var yearOk = !tr.fixYear || actualYear === tr.targetYear;
          var sortOk = !tr.fixSort || actualSort === tr.targetSort;

          if (yearOk && sortOk) {
            verified++;
          } else {
            mismatches++;
            if (mismatches <= 10) {
              print('    MISMATCH: "' + tr.name + '" in "' + p.album + '"');
              if (!yearOk) print('      year: expected ' + tr.targetYear + ', got ' + actualYear);
              if (!sortOk) print('      sortAlbum: expected "' + tr.targetSort + '", got "' + actualSort + '"');
            }
          }
        } catch (e) {
          mismatches++;
        }
      }
    }
  }

  print('  Verified: ' + verified + ' tracks OK, ' + mismatches + ' mismatches.');
  if (mismatches > 10) {
    print('  (Showing first 10 mismatches only)');
  }
  return mismatches;
}

// ── Main ────────────────────────────────────────────────────────────────────

function run(argv) {
  var opts = parseArgs(argv);

  print('================================================================');
  print('  fix_live_years.js -- Fix nugs.net year metadata');
  print('  Mode: ' + (opts.commit ? 'COMMIT (will write changes)' : 'DRY RUN (read-only)'));
  print('================================================================');
  print('');

  // Determine target artists
  var targetArtists = {};
  if (opts.customArtist) {
    // Arbitrary artist — use the name as-is for exact matching
    targetArtists[opts.customArtist] = [opts.customArtist];
  } else if (opts.artistFilter) {
    var filterLower = opts.artistFilter.toLowerCase();
    var found = false;
    for (var key in ARTIST_ALIASES) {
      if (key.toLowerCase() === filterLower) {
        targetArtists[key] = ARTIST_ALIASES[key];
        found = true;
        break;
      }
    }
    if (!found) {
      print('ERROR: Unknown artist "' + opts.artistFilter + '"');
      print('Known artists: ' + Object.keys(ARTIST_ALIASES).join(', '));
      print('Tip: Use --custom-artist "Name" for artists not in the built-in list.');
      return;
    }
  } else {
    targetArtists = ARTIST_ALIASES;
  }

  // Connect to Music.app
  print('  Connecting to Music.app...');
  var music = getMusic();

  // Preflight
  print('  Running preflight checks...');
  try {
    preflight(music);
    print('  Preflight OK.');
  } catch (e) {
    print('  PREFLIGHT FAILED: ' + e.message);
    print('  Make sure Music.app is open and has tracks in the library.');
    return;
  }

  // Phase 1: Scan
  print('');
  print('  Scanning library...');
  var allPlans = {};
  var grandTotalTracks = 0;

  for (var artistKey in targetArtists) {
    print('  Scanning ' + artistKey + '...');
    var result = scanArtist(music, artistKey, targetArtists[artistKey]);
    print('    Found ' + result.trackCount + ' tracks across ' + Object.keys(result.albums).length + ' albums');

    var plan = buildFixPlan(result.albums);
    allPlans[artistKey] = plan;
    printPlan(plan, artistKey);
    grandTotalTracks += result.trackCount;
  }

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
  print('  SUMMARY: ' + totalFixAlbums + ' albums, ' + totalFixTracks + ' tracks need fixes');
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
  print('');
  print('  Writing backup...');
  var backupPath = writeBackup(allPlans);
  if (backupPath) {
    print('  Backup saved to: ' + backupPath);
  }

  // Phase 2: Confirm & Apply
  print('');
  print('  WARNING: About to update ' + totalFixAlbums + ' albums (' + totalFixTracks + ' tracks).');
  print('  WARNING: Do NOT sync iCloud Music Library during this process.');
  print('');

  // JXA doesn't have stdin — use a system dialog for confirmation
  var currentApp = Application.currentApplication();
  currentApp.includeStandardAdditions = true;
  try {
    currentApp.displayDialog(
      'fix_live_years.js will update ' + totalFixAlbums + ' albums (' + totalFixTracks + ' tracks).\n\n' +
      'Backup saved to:\n' + backupPath + '\n\n' +
      'Do NOT sync iCloud Music Library during this process.\n\n' +
      'Click OK to proceed or Cancel to abort.',
      { withTitle: 'Confirm Year Fix', buttons: ['Cancel', 'OK'], defaultButton: 'OK' }
    );
  } catch (e) {
    print('  Aborted by user.');
    return;
  }

  // Apply
  var applyResult = applyFixes(allPlans);

  // Verify
  var mismatches = verify(music, allPlans);

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
