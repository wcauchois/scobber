var http = require('http'),
    querystring = require('querystring'),
    sqlite3 = require('sqlite3').verbose(),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    mustache = require('mustache'),
    _und = require('underscore');

function read_config(file_name) {
  if (fs.existsSync(file_name)) {
    var contents = fs.readFileSync(file_name, 'utf8');
    var rendered_contents = mustache.render(contents, {});
    return JSON.parse(rendered_contents.trim());
  } else {
    return {};
  }
}

function parse_time(str) {
  var groups = str.match(/(\d+)(.*)/);
  if (!groups) {
    throw new Exception('Unparseable time interval: ' + str);
  }

  num = parseInt(groups[1]);
  unit = groups[2];
  if (unit.length > 0) {
    switch(unit) {
      case 'min':
      case 'm':
        num *= (60 * 1000);
        break;
      case 'sec':
      case 's':
        num *= 1000;
        break;
      case 'hour':
      case 'hours':
      case 'h':
        num *= (60 * 60 * 1000);
        break;
      default:
        throw new Error('Unrecognized time unit: ' + unit);
    }
  }
  return num;
}

var config = _und.extend(read_config('config.default.json'), read_config('config.json'));
config['download_interval'] = parse_time(config['download_interval']);
config['check_interval'] = parse_time(config['check_interval']);
var db = new sqlite3.Database(path.join(config.dir_name, 'favorites.db'));

function log_error(err) {
  console.error(err.message);
}

function append_client_id(url) {
  return url + '?client_id=' + config.client_id;
}

function retrieve_favorites(callback) {
  var base_url = 'http://api.soundcloud.com/users/wcauchois/favorites.json'
  http.get(append_client_id(base_url) + '&limit=10', function(res) {
    res.setEncoding('utf8');
    var data = '';
    res.on('readable', function() {
      data += res.read();
    }).on('end', function() {
      try {
        callback(null, JSON.parse(data));
      } catch(ex) {
        callback(new Error('retrieve_favorites: Malformed JSON response'));
      }
    });
  }).on('error', callback);
}

function download_song(authed_stream_url, out_file_name, callback) {
  http.get(authed_stream_url, function(res) {
    if ('location' in res.headers && res.statusCode == 302) {
      console.log('Got redirect, downloading from ' + res.headers['location']);
      http.get(res.headers['location'], function(res) {
        var out_file = fs.createWriteStream(out_file_name);
        res.on('end', function() { callback(null); });
        res.pipe(out_file);
      }).on('error', callback);
    } else {
      callback(new Error('download_song: Expected redirect'));
    }
  }).on('error', callback);
}

function is_already_downloaded(track_id, callback) {
  var q = 'select count(*) as c from tracks where track_id=?'
  db.all(q, track_id, function(err, rows) {
    if (!err) {
      callback(null, rows[0].c > 0);
    } else callback(err);
  });
}

function generate_track_filename(original_title) {
  return original_title.replace(/[^a-zA-Z0-9]/g, '_').replace(/_{2,}/g, '_') + '.mp3';
}

function download_new_favorites() {
  console.log('Retrieving favorites');
  retrieve_favorites(function(err, tracks) {
    if (!err) {
      var track_ids = tracks.map(function(t) { return t.id; });
      async.map(track_ids, is_already_downloaded, function(err, results) {
        var to_download = [];
        console.log('Analyzing favorites');
        for (var i = 0; i < tracks.length; i++) {
          var track = tracks[i], already_downloaded = results[i];
          if (already_downloaded) {
            console.log('Looks like we already downloaded ' + track.title);
          } else {
            console.log('Cool! ' + track.title + ' is new.');
            to_download.push(track);
          }
        }
        console.log("Let's download " + to_download.length + " tracks");
        function download_next_track() {
          if (to_download.length == 0) return;
          var track = to_download.pop();
          console.log('Starting download of ' + track.title);
          var filename = generate_track_filename(track.title);
          var the_path = path.join(config.dir_name, filename);
          console.log('Path: ' + the_path);
          download_song(append_client_id(track.stream_url), the_path,
            function(err) {
              if (!err) {
                console.log('Successfully downloaded ' + track.title);
                var q = 'insert into tracks values(?, ?, ?, ?, ?)';
                db.run(q, track.id, track.title, filename, track.permalink, JSON.stringify(track),
                  function(err) {
                    if (!err) {
                      console.log('Added ' + track.title + ' to the DB');
                    } else log_error(err);
                  });
                if (to_download.length > 0) {
                  console.log('Starting next download in ' + config.download_interval + 'ms');
                  setTimeout(download_next_track, config.download_interval);
                } else {
                  console.log('Done downloading new favorites');
                }
              } else log_error(err);
            });
        }
        download_next_track();
      });
    } else log_error(err);
  });
}

setInterval(download_new_favorites, config.check_interval);
download_new_favorites();

