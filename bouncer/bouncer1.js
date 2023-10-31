const SQLite = require("better-sqlite3");
const WebSocket = require("ws");
const { relays } = require("../config");
const socks = new Set();
const sess = new SQLite(process.env.IN_MEMORY ? null : (__dirname + "/../.temporary.db"));
const csess = new Map();

// Handle database....
sess.unsafeMode(true);

// Temporary database.
sess.exec("CREATE TABLE IF NOT EXISTS sess (cID TEXT, subID TEXT);");
sess.exec("CREATE TABLE IF NOT EXISTS events (cID TEXT, subID TEXT, eID TEXT);"); // To prevent transmitting duplicates

// CL - User socket
module.exports = (ws, req) => {
  ws.id = process.pid + Math.floor(Math.random() * 1000) + "_" + csess.size;
  ws.on("message", data => {
    try {
      data = JSON.parse(data);
    } catch {
      return ws.send(
        JSON.stringify(["NOTICE", "error: bad JSON."])
      )
    }

    switch (data[0]) {
      case "EVENT":
        if (!data[1]?.id) return ws.send(JSON.stringify(["NOTICE", "error: no event id."]));
        bc(data);
        ws.send(JSON.stringify(["OK", data[1]?.id, true, ""]));
        break;
      case "REQ":
        if (data.length < 3) return ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        if (typeof(data[2]) !== "object") return ws.send(JSON.stringify(["NOTICE", "expected filter to be obj, instead gives the otherwise."]));
        data[1] = ws.id + ":" + data[1];
        // eventname -> 1_eventname
        bc(data);
        sess.prepare("INSERT INTO sess VALUES (?, ?);").run(ws.id, data[1]);
        ws.send(JSON.stringify(["EOSE", data[1]]));
        break;
      case "CLOSE":
        if (typeof(data[1]) !== "string") ws.send(JSON.stringify(["NOTICE", "error: bad request."]));
        data[1] = ws.id + ":" + data[1];
        bc(data);
        sess.prepare("DELETE FROM sess WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        sess.prepare("DELETE FROM events WHERE cID = ? AND subID = ?;").run(ws.id, data[1]);
        break;
      default:
        console.warn(process.pid, "---", "Unknown command:", data.join(" "));
        ws.send(JSON.stringify(["NOTICE", "error: unrecognized command."]));
        break;
    }
  });

  ws.on('error', console.error);
  ws.on('close', _ => {
    console.log(process.pid, "---", "Sock", ws.id, "has disconnected.");
    csess.delete(ws.id);
    for (i of sess.prepare("SELECT subID FROM sess WHERE cID = ?").iterate(ws.id)) {
      bc(["CLOSE", i.subID]);
    }

    sess.prepare("DELETE FROM sess WHERE cID = ?;").run(ws.id);
    sess.prepare("DELETE FROM events WHERE cID = ?;").run(ws.id);
  });

  csess.set(ws.id, ws);
}

// CL - Broadcast message to every existing client sockets
function bc_c(msg) {
  csess.forEach(sock => {
    if (sock.readyState >= 2) return csess.delete(sock.id);
    sock.send(JSON.stringify(msg));
  });
}

// WS - Broadcast message to every existing sockets
function bc(msg) {
  socks.forEach(sock => {
    if (sock.readyState >= 2) return socks.delete(sock);
    sock.send(JSON.stringify(msg));
  });
}

// WS - Sessions
function newConn(addr) {
  const relay = new WebSocket(addr);

  relay.addr = addr;
  relay.on('open', _ => {
    socks.add(relay); // Add this socket session to [socks]
    console.log(process.pid, "---", `[${socks.size}/${relays.length}]`, relay.addr, "is connected");
  });

  relay.on('message', data => {
    try {
      data = JSON.parse(data);
    } catch (error) {
      return console.error(error);
    }

    switch (data[0]) {
      case "EVENT": {
        const subID = data[1];
        const args = subID.split(":")
        /*
            args[0]                 -> Client socket ID (bouncer -> client)
            args.slice(1).join(":") -> Actual subscription ID that socket client requested.
         */
        const cID = args[0];
        const sID = args.slice(1).join(":");

        if (!sess.prepare("SELECT * FROM sess WHERE cID = ? AND subID = ?;").get(cID, subID)) return relay.send(JSON.stringify(["CLOSE", subID]));
        if (sess.prepare("SELECT * FROM events WHERE cID = ? AND subID = ? AND eID = ?;").get(cID, subID, data[2]?.id)) return; // No need to transmit once it has been transmitted before.

        sess.prepare("INSERT INTO events VALUES (?, ?, ?);").run(cID, subID, data[2]?.id);
        data[1] = sID;
        csess.get(cID)?.send(JSON.stringify(data));
        break;
      }
    }
  });

  relay.on('error', _ => console.error(process.pid, "-!-", relay.addr, _.toString()));
  relay.on('close', _ => {
    socks.delete(relay) // Remove this socket session from [socks] list
    console.log(process.pid, "-!-", `[${socks.size}/${relays.length}]`, "Disconnected from", relay.addr);

    setTimeout(_ => newConn(addr), 5000); // As a bouncer server, We need to reconnect.
  });
}

relays.forEach(newConn);