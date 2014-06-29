var http = require('http'),
    querystring = require('querystring'),
    sqlite3 = require('sqlite3').verbose(),
    fs = require('fs'),
    async = require('async'),
    path = require('path'),
    mustache = require('mustache'),
    _und = require('underscore'),
    request = require('request'),
    util = require('util');

function read_config(rel_file_name) {
  // Look relative to the directory the script is in.
  file_name = path.resolve(__dirname, rel_file_name);
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

function UrlBuilder(base) {
  this._base = base;
  this._path = '/';
  this._params = {};
}

_und.extend(UrlBuilder.prototype, {
  path: function(path) {
    this._path = path;
    return this;
  },

  param: function(key, value) {
    this._params[key] = (this._params[key] || []).concat([value]);
    return this;
  },

  result: function() {
    var qs = querystring.stringify(this._params);
    return this._base + this._path + (qs.length > 0 ? ('?' + qs) : '');
  }
});

var config = _und.extend(read_config('config.default.json'), read_config('config.json'));
config['download_interval'] = parse_time(config['download_interval']);
config['check_interval'] = parse_time(config['check_interval']);
var db = new sqlite3.Database(path.join(config.dir_name, 'favorites.db'));

function log_error(err) {
  util.log('ERROR ' + (_und.isString(err) ? err : err.message));
}

function SoundCloudApi(client_id) {
  this.client_id = client_id;
}

_und.extend(SoundCloudApi.prototype, {
  url_builder: function() {
    return new UrlBuilder('http://api.soundcloud.com').param('client_id', config.client_id);
  },

  call_json: function(url, callback) {
    request({url: url, json: true}, function(error, response, body) {
      if(error || response.statusCode !== 200) {
        callback(error ||
          new Error('Got code ' + response.statusCode + ' calling ' + url));
      } else {
        callback(null, body);
      }
    });
  },

  retrieve_favorites: function(user_name, callback) {
    var endpoint_url = this.url_builder()
      .path('/users/' + user_name + '/favorites.json')
      .param('limit', '10')
      .result();
    this.call_json(endpoint_url, callback);
  }
});

var sc_api = new SoundCloudApi(config.client_id);

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

function download_and_add(track, callback) {
  var filename = generate_track_filename(track.title);
  var the_path = path.join(config.dir_name, filename);
  util.log('Downloading ' + track.title + ' to ' + filename);

  var authed_stream_url = new UrlBuilder(track.stream_url)
    .param('client_id', config.client_id)
    .result();

  request(authed_stream_url, function(error, response) {
    if (error) {
      callback(error);
    } else if (response.statusCode !== 200) {
      callback(new Error(
        'Failed to download, code ' + response.statusCode));
    } else {
      var q = 'insert into tracks values(?, ?, ?, ?, ?)';
      db.run(q,
        track.id,
        track.title,
        filename,
        track.permalink,
        JSON.stringify(track),
        callback);
    }
  }).pipe(fs.createWriteStream(the_path));
}

function download_new_favorites() {
  util.log('Checking for new favorites');
  sc_api.retrieve_favorites(config.user_name, function(err, tracks) {
    if (!err) {
      var track_ids = tracks.map(function(t) { return t.id; });
      async.map(track_ids, is_already_downloaded, function(err, results) {
        var to_download = [];
        for (var i = 0; i < tracks.length; i++) {
          var track = tracks[i], already_downloaded = results[i];
          !already_downloaded && to_download.push(track);
        }
        util.log('Downloading ' + to_download.length + ' new tracks');
        async.waterfall(_und.map(to_download, function(track, i) {
          return function(callback) {
            download_and_add(track, function(err) {
              if (err) {
                callback(err);
              } else {
                if (i === to_download.length - 1) {
                  // Last track, return immediately.
                  callback();
                } else {
                  setTimeout(callback, config.download_interval);
                }
              }
            });
          }
        }), function(err) {
          if (err) {
            log_error(err);
          } else {
            util.log('Done downloading.');
          }
        });
      });
    } else {
      log_error(err);
    }
  });
}

if (require.main === module) {
  util.log('Starting up');

  var download_interval = null;

  function force_refresh() {
    download_interval && clearInterval(download_interval);
    download_new_favorites();
    download_interval = setInterval(download_new_favorites, config.check_interval);
  }

  process.on('SIGHUP', force_refresh);

  if (config.http_listen) {
    http.createServer(function(req, res) {
      util.log('HTTP ' + req.method + ' ' + req.url);
      if (req.method === 'POST') {
        force_refresh();
      }
      res.end();
    }).listen(config.http_listen, '0.0.0.0');
    util.log('HTTP server listening on port ' + config.http_listen);
  }

  force_refresh();
}

