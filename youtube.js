var http = require('http'),
    querystring = require('querystring'),
    sqlite3 = require('sqlite3').verbose(),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    _und = require('underscore'),
    request = require('request'),
    util = require('util'),
    sax = require('sax'),
    sets = require('simplesets'),
    spawn = require('child_process').spawn;

var config = {
  "playlist_id": "PLuf01ZxaC8YsCcTC05ejIXBNq7PfPD72-",
  "dir_name": "/home/wcauchois/Dropbox/YouTube_Downloads",
  "check_interval": 60000 // 1 minute
};

function log_error(err) {
  util.log('ERROR ' + (_und.isString(err) ? err : err.message));
}

var playlist_rss_feed_template = "http://gdata.youtube.com/feeds/api/playlists/%s";
var video_url_template = "https://www.youtube.com/watch?v=%s";
var video_id_regex = /youtube.com\/v\/([^?$]*)/;

function fetch_youtube_playlist(playlist_id, callback) {
  var parser = sax.parser(true /* strict */);
  var results = [];

  parser.onerror = function(e) { callback(e); };
  parser.onopentag = function (node) {
    if (node.name === 'media:content' &&
        node.attributes.medium === 'video' &&
        node.attributes.type === 'application/x-shockwave-flash') {
      var match = node.attributes.url.match(video_id_regex);
      if (match) {
        results.push(match[1]);
      } else {
        util.log("WARNING(fetch_youtube_playlist): Failed to parse video URL: " +
          node.attributes.url);
      }
    }
  };
  parser.onend = function() { callback(null, results); }

  var feed_url = util.format(playlist_rss_feed_template, playlist_id);
  request(feed_url, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      parser.write(body).close();
    } else {
      callback(error || new Error("Failed to fetch, code " + response.statusCode));
    }
  });
}

function download_youtube_video(video_id, out_dir, callback) {
  var dl_proc = spawn('youtube-dl', [
    '--no-progress',
    '--extract-audio',
    '--audio-format', 'mp3',
    '-o', '%(title)s.%(ext)s',
    util.format(video_url_template, video_id)
  ], {cwd: out_dir, stdio: 'pipe'});
  var out_file_name = null;
  dl_proc.stdout.on('data', function(data) {
    var line = data.toString().trim();
    util.log('youtube-dl: ' + line);
    var dest_match = line.match(/Destination: (.*)/);
    if (dest_match) {
      out_file_name = dest_match[1];
    }
  });
  dl_proc.stderr.on('data', function(data) {
    util.log('youtube-dl: ' + data.toString().trim());
  });
  dl_proc.on('close', function(code) {
    if (code !== 0) {
      callback(new Error("youtube-dl exited with code " + code));
    } else {
      callback(null, out_file_name);
    }
  });
}

function HistoryFile() {}
_und.extend(HistoryFile.prototype, {
  get_file_name: function() { return path.join(config.dir_name, "history.txt"); },

  load: function(callback) {
    // TODO: Create the file if it doesn't exist?
    fs.readFile(this.get_file_name(), 'utf-8', function(err, data) {
      if (err) {
        callback(err);
      } else {
        var lines = data.split('\n');
        this.rows = [];
        lines.forEach(function(line) {
          line = line.trim();
          if (line.length > 0) {
            this.rows.push(line.split('\t'));
          }
        }.bind(this));
        this.video_id_set = new sets.StringSet(this.rows.map(function(row) {
          return row[0];
        }));
        callback(null);
      }
    }.bind(this));
  },

  save: function(callback) {
    var buffer = '';
    this.rows.forEach(function(row) {
      buffer += row.join('\t') + '\n';
    });
    fs.writeFile(this.get_file_name(), buffer, 'utf-8', function(err) {
      callback(err);
    });
  },

  find_missing_ids: function(given_ids) {
    var given_id_set = new sets.StringSet(given_ids);
    return given_id_set.difference(this.video_id_set).array();
  },

  add_rows: function(new_rows) {
    this.rows = this.rows.concat(new_rows);
  }
});

function download_new_videos() {
  util.log('Checking for new videos');
  var hist_file = new HistoryFile();
  async.parallel([
    function(cb) { fetch_youtube_playlist(config.playlist_id, cb); },
    function(cb) { hist_file.load(cb); }
  ], function(err, results) {
    if (err) {
      log_error(err);
    } else {
      var playlist_contents = results[0];
      var missing_ids = hist_file.find_missing_ids(playlist_contents);
      if (missing_ids.length === 0) {
        util.log("No new videos to download");
      } else {
        util.log("Downloading " + missing_ids.length + " new videos");
        async.mapSeries(missing_ids, function(missing_id, callback) {
          download_youtube_video(missing_id, config.dir_name, function(err, video_name) {
            callback(err, video_name && [missing_id, video_name]);
          });
        }, function(err, new_rows) {
          if (err) {
            log_error(err);
          } else {
            util.log("Done downloading");
            hist_file.add_rows(new_rows);
            hist_file.save(function(err) {
              if (err) {
                log_error(err);
              } else {
                util.log("Saved history file");
              }
            });
          }
        });
      }
    }
  });
}

if (require.main === module) {
  util.log('Starting up');

  var download_interval = null;

  function force_refresh() {
    download_interval && clearInterval(download_interval);
    download_new_videos();
    download_interval = setInterval(download_new_videos, config.check_interval);
  }

  process.on('SIGHUP', force_refresh);
  force_refresh();
}

//download_youtube_video('nRRnnSGpD3A', config.dir_name, function(x, y) { console.log(x); console.log(y); });
//fetch_youtube_playlist(config.playlist_id, function(x, y) { console.log(x); console.log(y); });

