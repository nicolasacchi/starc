# frozen_string_literal: true

require "rails_helper"
require "net/http"
require "securerandom"

# Two real players, two real WebSocket connections, one real match, played to a
# conclusion against a real Puma on a real port.
#
# Everything below the socket is the shipping stack: the REST API issues the
# tokens and moves the match through its lobby states, ActionCable carries the
# gameplay, `Starc::MatchRunner` steps the fixed 50 ms simulation and broadcasts
# snapshots, and the replay is written to SQLite before anyone is told the match
# ended. Nothing here is stubbed, because the bugs worth catching — a start
# position on the world edge, a snapshot cadence that is not 10 Hz, a rejection
# indexed against the wrong command, a replay URL that 404s — are exactly the
# ones a mocked channel cannot see.
#
# The server runs in its own process against the real test database, so a test
# transaction is invisible to it. Every player and match here is created through
# the real HTTP API under a random suffix and destroyed afterwards.
RSpec.describe "a full match over the real stack", :e2e do
  # Long enough for the server to boot Rails and prepare the database, short
  # enough that a wedged boot fails the suite instead of stalling it.
  BOOT_TIMEOUT = 120

  # Every wait in this file is bounded. These are the bounds, and each call site
  # says what it is waiting for.
  CONNECT_TIMEOUT = 15
  START_TIMEOUT = 20
  SNAPSHOT_TIMEOUT = 20
  COMMAND_TIMEOUT = 15
  END_TIMEOUT = 20

  # A trained unit only appears once its build timer expires, and an scv takes
  # 17 s of simulation time, so waiting for the spawned entity needs a longer
  # bound than waiting for the command to be *accepted*.
  BUILD_COMPLETE_TIMEOUT = 30

  # PROTOCOL.md §5: 20 Hz simulation, snapshots every second tick.
  EXPECTED_TICK_RATE = 20
  EXPECTED_SNAPSHOT_RATE = 10
  EXPECTED_SNAPSHOT_TICK_INTERVAL = EXPECTED_TICK_RATE / EXPECTED_SNAPSHOT_RATE

  # PROTOCOL.md §4: `ids` is capped per command.
  MAX_IDS_PER_COMMAND = 256

  before(:all) do
    # ActionCable refuses an upgrade whose `Origin` is not allowed, and this
    # harness is not a browser, so it has to name one. The initializer widens
    # `allowed_request_origins` from this variable, and the spawned server
    # inherits the environment because `E2eServer.start!` does not clear it.
    ENV["ALLOWED_CABLE_ORIGINS"] = "http://127.0.0.1,http://localhost"
    begin
      E2eServer.start!(boot_timeout: BOOT_TIMEOUT)
    rescue StandardError => e
      raise "#{e.message}\n--- e2e server log ---\n#{E2eServer.log_tail}"
    end
  end

  after(:all) { E2eServer.stop! }

  # ------------------------------------------------------------------ helpers

  # Waits for `description` to become true, polling the predicate rather than
  # sleeping a guessed interval. A failed wait names what it was waiting for and
  # appends the server log, because a match that silently stalls is a server
  # problem and the server log is where the reason is.
  def wait_until(description, timeout: 10, server: true)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      value = yield
      return value if value
      break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

      sleep 0.02
    end

    detail = server ? "\n--- e2e server log ---\n#{E2eServer.log_tail}" : ""
    raise "timed out after #{timeout}s waiting for #{description}#{detail}"
  end

  # Drains a client's inbox until a message of `type` shows up, or the deadline
  # passes. Returns the matching deliveries, so a caller can assert on how many
  # arrived rather than merely that one did.
  def await_type(client, type, timeout:, description: nil, channel_key: nil)
    wanted = description || "a #{type} message"
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    found = []

    loop do
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      break if remaining <= 0

      begin
        delivery = client.messages(timeout: [remaining, 0.25].min,
                                   description: "#{wanted} (already seen: #{client.describe_inbox})")
      rescue WebSocketClient::TimeoutError
        next
      end

      next if channel_key && delivery.channel_key != channel_key.to_s
      next unless delivery.type == type

      found << delivery
      return found
    end

    raise "timed out after #{timeout}s waiting for #{wanted} on #{client.label}\n" \
          "--- e2e server log ---\n#{E2eServer.log_tail}"
  end

  # A short, human-readable summary of what a client has seen, for failure text.

  def http_json(method, path, token: nil, body: nil)
    uri = URI("#{E2eServer.base_url}#{path}")
    klass = Net::HTTP.const_get(method.to_s.capitalize)
    request = klass.new(uri)
    request["Authorization"] = "Bearer #{token}" if token
    if body
      request["Content-Type"] = "application/json"
      request.body = JSON.generate(body)
    end

    response = Net::HTTP.start(uri.hostname, uri.port, read_timeout: 20) { |http| http.request(request) }
    parsed = response.body.to_s.empty? ? {} : JSON.parse(response.body)
    [response.code.to_i, parsed]
  end

  # Registers a player through the real endpoint, so the token is issued by the
  # code under test rather than fabricated.
  def register_player(tag)
    name = "e2e#{tag}#{SecureRandom.hex(3)}"
    status, body = http_json(:post, "/api/v1/players", body: { name: name, password: "hunter2" })
    raise "registering #{name} failed with #{status}: #{body.inspect}\n#{E2eServer.log_tail}" unless status == 201

    { name: name, id: body.dig("player", "id"), token: body.fetch("token"), client: nil }
  end

  def destroy_player(player)
    Player.where(id: player[:id]).destroy_all
  rescue StandardError => e
    warn("e2e cleanup: could not destroy player #{player[:id]}: #{e.class}: #{e.message}")
  end

  before do
    @suffix = SecureRandom.hex(3)
    @player_a = register_player("a#{@suffix}")
    @player_b = register_player("b#{@suffix}")
    @clients = []

    # Both players join the lobby and subscribe before anything starts, which is
    # the order a real client uses: know about the room, then start the game.
    @player_a[:client] = open_cable(@player_a, "A")
    @player_b[:client] = open_cable(@player_b, "B")
  end

  after do
    @clients&.each { |c| c.close rescue nil } # rubocop:disable Style/RescueModifier
    [@match_id].compact.each do |id|
      Match.where(id: id).destroy_all
    rescue StandardError => e
      warn("e2e cleanup: could not destroy match #{id}: #{e.class}: #{e.message}")
    end
    [@player_a, @player_b].compact.each { |p| destroy_player(p) }
  end

  def open_cable(player, label)
    client = CableClient.open(E2eServer.base_url, token: player[:token],
                                                 open_timeout: CONNECT_TIMEOUT,
                                                 label: "#{label}(#{player[:name]})")
    @clients << client
    client
  end

  # Runs the whole lobby handshake over real HTTP and returns the match id.
  #
  # A creates the match, B joins, both subscribe to `lobby` and `game:<id>`, both
  # `identify`, both ready, and A starts. Every step is the shipping API, so the
  # suite exercises the same path a browser does.
  def start_match!
    status, created = http_json(:post, "/api/v1/matches", token: @player_a[:token], body: {
                                  name: "e2e-#{@suffix}", mode: "melee",
                                  map_id: "altaior", max_players: 2
                                })
    raise "creating the match failed with #{status}: #{created.inspect}\n#{E2eServer.log_tail}" unless status == 201

    @match_id = created.dig("match", "id")
    expect(@match_id).to be_a(Integer)

    status, joined = http_json(:post, "/api/v1/matches/#{@match_id}/join", token: @player_b[:token], body: {})
    raise "B joining failed with #{status}: #{joined.inspect}\n#{E2eServer.log_tail}" unless status == 200

    game_params = { channel: "GameChannel", match_id: @match_id }
    @player_a[:client].subscribe(channel: "LobbyChannel")
    @player_b[:client].subscribe(channel: "LobbyChannel")
    @player_a[:client].subscribe(game_params)
    @player_b[:client].subscribe(game_params)
    @game_key = CableClient.channel_key(game_params)

    # The server registers a subscription asynchronously relative to the
    # client's write, so a message that beats its own confirmation is refused
    # outright. The client holds those frames; awaiting the confirmation here
    # turns a broken ordering rule into a clear "never confirmed" failure
    # instead of a `game:start` that silently never arrives.
    [@player_a[:client], @player_b[:client]].each do |client|
      client.await_confirmation(CableClient.channel_key(channel: "LobbyChannel"), timeout: CONNECT_TIMEOUT)
      client.await_confirmation(@game_key, timeout: CONNECT_TIMEOUT)
    end

    [@player_a, @player_b].each do |player|
      player[:client].send_message(game_params, { "v" => 1, "t" => "identify", "token" => player[:token] })
    end

    # The match cannot start until both seats are ready, so this is where the
    # two clients are proven to be attached to the room.
    wait_until("both players to be seated in match #{@match_id}", timeout: 10) do
      http_json(:get, "/api/v1/matches/#{@match_id}").last.dig("match", "player_count") == 2
    end

    [@player_a, @player_b].each do |player|
      status, ready = http_json(:post, "/api/v1/matches/#{@match_id}/ready", token: player[:token],
                                                     body: { ready: true })
      raise "ready failed with #{status}: #{ready.inspect}" unless status == 200
    end

    status, started = http_json(:post, "/api/v1/matches/#{@match_id}/start", token: @player_a[:token], body: {})
    raise "starting failed with #{status}: #{started.inspect}\n#{E2eServer.log_tail}" unless status == 200

    @map_id = started.dig("match", "map_id")
    @match_id
  end

  # Both clients' `game:start`, asserted field-for-field against PROTOCOL.md §3.
  def expect_game_start!(client)
    deliveries = await_type(client, "game:start", timeout: START_TIMEOUT,
                                               description: "game:start after the match starts",
                                               channel_key: @game_key)
    payload = deliveries.first.payload
    log = "\n--- e2e server log ---\n#{E2eServer.log_tail}"

    expect(payload["v"]).to eq(1), "game:start v#{log}"
    expect(payload["match_id"]).to eq(@match_id), "game:start match_id#{log}"
    expect(payload["seed"]).to be_a(Integer), "game:start seed must be a 32-bit unsigned integer#{log}"
    expect(payload["seed"]).to be_between(0, 2**32 - 1), "game:start seed out of range#{log}"
    expect(payload["map_id"]).to eq("altaior"), "game:start map_id#{log}"
    expect(payload["tick_rate"]).to eq(EXPECTED_TICK_RATE), "game:start tick_rate#{log}"
    expect(payload["snapshot_rate"]).to eq(EXPECTED_SNAPSHOT_RATE), "game:start snapshot_rate#{log}"
    expect(payload["countdown_ms"]).to be_a(Integer), "game:start countdown_ms#{log}"
    expect(payload["countdown_ms"]).to be_positive, "game:start countdown_ms must be positive#{log}"

    players = payload["players"]
    expect(players).to be_an(Array), "game:start players#{log}"
    expect(players.size).to eq(2), "game:start players should list both seats#{log}"
    expect(players.map { |p| p["player_id"] }).to contain_exactly(@player_a[:id], @player_b[:id])

    players.each do |seat|
      expect(seat).to include("slot" => be_an(Integer), "race" => be_a(String), "name" => be_a(String),
                              "team" => be_an(Integer))
      expect(seat["race"]).to be_in(MatchPlayer::RACES)

      # PROTOCOL.md §3 puts the start point on the x/z ground plane. A `y`/`z`
      # mix-up here silently puts everyone at the world edge, and the clients
      # would dutifully render it — so the guard is that BOTH coordinates are
      # present and NEITHER is zero.
      start = seat["start"]
      expect(start).to be_a(Hash), "seat #{seat['player_id']} start#{log}"
      expect(start.keys).to contain_exactly("x", "z"), "seat #{seat['player_id']} start keys#{log}"
      expect(start["x"]).to be_a(Numeric), "seat #{seat['player_id']} start.x must be a number#{log}"
      expect(start["z"]).to be_a(Numeric), "seat #{seat['player_id']} start.z must be a number#{log}"
      expect(start["x"]).to be_positive, "seat #{seat['player_id']} start.x is zero — a y/z mix-up puts " \
                                         "every player on the world edge#{log}"
      expect(start["z"]).to be_positive, "seat #{seat['player_id']} start.z is zero — a y/z mix-up puts " \
                                         "every player on the world edge#{log}"
    end

    payload
  end

  # Collects snapshots from a client until `count` have arrived.
  def collect_snapshots(client, count, timeout: SNAPSHOT_TIMEOUT)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    snapshots = []
    while snapshots.size < count
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise "timed out after #{timeout}s waiting for #{count} snapshots, got #{snapshots.size}\n" \
            "already seen by #{client.label}: #{client.describe_inbox}\n" \
            "--- e2e server log ---\n#{E2eServer.log_tail}" if remaining <= 0

      begin
        delivery = client.messages(timeout: [remaining, 0.25].min,
                                   description: "the next snapshot (collected #{snapshots.size}/#{count})")
      rescue WebSocketClient::TimeoutError
        next
      end

      next unless delivery.type == "game:snapshot"

      @last_tick = delivery.payload["tick"].to_i
      snapshots << delivery.payload
    end

    snapshots
  end

  # PROTOCOL.md §5: snapshots go out on every second tick. Asserting the median
  # gap over ~20 samples is what makes this a cadence assertion — "a snapshot
  # arrived" would be satisfied by a single message.
  def expect_snapshot_cadence!(snapshots)
    ticks = snapshots.map { |s| s["tick"] }
    expect(ticks).to all(be_an(Integer))

    gaps = ticks.each_cons(2).map { |a, b| b - a }
    expect(gaps).not_to be_empty

    median = median_of(gaps)
    expect(median).to eq(EXPECTED_SNAPSHOT_TICK_INTERVAL),
                        "median snapshot interval was #{median} ticks (gaps: #{gaps.inspect}); " \
                        "PROTOCOL.md §5 requires every #{EXPECTED_SNAPSHOT_TICK_INTERVAL}nd tick"
  end

  def median_of(values)
    sorted = values.sort
    mid = sorted.size / 2
    sorted.size.odd? ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0
  end

  # PROTOCOL.md §5: the server's `y` is authoritative terrain height — a client
  # that recomputes it from its own height field makes units float or sink.
  #
  # The tolerance is half of the last digit the wire carries, not 1e-6: the
  # snapshot rounds `y` to three decimals (`Entity#round3`) to keep frames
  # small, so a millimetre is the finest fact the protocol actually conveys.
  # That is still far tighter than the bug this guards — a y/z mix-up moves a
  # unit by tens of metres, not micrometres.
  Y_PRECISION = 5e-4

  # Every state in which an entity is travelling between two points. A
  # harvesting worker shuttles in `harvesting` and `unloading` just as a
  # combat unit does in `attacking`, so "not moving" has to mean "none of
  # these", not "not `moving`".
  TRAVELLING_STATES = %w[moving attacking returning building harvesting unloading].freeze

  def expect_entity_heights!(entities)
    terrain = Starc::Sim::Terrain.for("altaior")
    # Only entities that are standing still. `x` and `z` are rounded to three
    # decimals on the wire too, so re-deriving the height at the *rounded*
    # position of something crossing a slope measures the rounding of the
    # position, not a defect in the height. A stationary unit is the honest
    # sample, and it is what this assertion is actually about.
    sample = entities.reject { |e| TRAVELLING_STATES.include?(e["st"]) }.first(12)
    expect(sample).not_to be_empty, "expected stationary entities to check heights on"

    sample.each do |entity|
      expected = terrain.height_at(entity["x"], entity["z"])
      expect(entity["y"]).to be_a(Numeric)
      expect(entity["y"]).to be_within(Y_PRECISION).of(expected),
                                      "entity #{entity['id']} (#{entity['ty']}, #{entity['st']}) is at " \
                                      "y=#{entity['y']} but terrain says #{expected} " \
                                      "at x=#{entity['x']} z=#{entity['z']}"
    end
  end

  def entities_of(snapshot, player_id: nil)
    list = snapshot["entities"]
    list = list.select { |e| e["pl"] == player_id } if player_id
    list
  end

  # Sends a `game:command` batch on the game channel, stamped with the last
  # snapshot tick this test has seen — exactly what a real client does, and
  # what the server rebases onto its authoritative tick (PROTOCOL.md §4).
  def send_commands(player, commands, from_tick: nil)
    tick = from_tick || @last_tick.to_i
    player[:client].send_message(
      { channel: "GameChannel", match_id: @match_id },
      { "v" => 1, "t" => "game:command", "id" => SecureRandom.uuid,
        "from_tick" => tick, "commands" => commands }
    )
    tick
  end

  # ------------------------------------------------------------------ examples

  it "plays a whole match: start, snapshots, commands, rejection, ending, replay, database" do
    start_match!

    # --- 1. game:start reaches both clients, field-for-field (PROTOCOL §3) ----
    start_a = expect_game_start!(@player_a[:client])
    start_b = expect_game_start!(@player_b[:client])

    # Both clients must reconstruct the identical opening from the same wire
    # facts, or they will disagree about the world from the first frame.
    expect(start_b["seed"]).to eq(start_a["seed"])
    expect(start_b["players"].map { |p| p["player_id"] }.sort)
      .to eq(start_a["players"].map { |p| p["player_id"] }.sort)

    # --- 2. snapshots flow at 10 Hz (PROTOCOL §5) ---------------------------
    snapshots_a = collect_snapshots(@player_a[:client], 21)
    expect_snapshot_cadence!(snapshots_a)

    # The second client is on the same match stream, so the two must observe
    # the *same* ticks — a per-client broadcast or a private simulation would
    # desync them. Asserting an exact tick is wrong: the two clients sample the
    # stream at different moments, so what matters is that the tick sets
    # overlap and stay on the same 2-tick grid.
    snapshots_b = collect_snapshots(@player_b[:client], 3)
    ticks_a = snapshots_a.map { |s| s["tick"] }
    ticks_b = snapshots_b.map { |s| s["tick"] }
    expect(ticks_b & ticks_a).not_to be_empty,
                                    "the two clients saw disjoint tick sets (A: #{ticks_a}, B: #{ticks_b})"
    expect_snapshot_cadence!(snapshots_b)

    # --- 3. the opening world is real and sits on the terrain (PROTOCOL §5) ---
    opening = snapshots_a.first
    entities = entities_of(opening)
    expect(entities).not_to be_empty, "the opening entity table was empty"

    # Each seat's opening is whatever its race opens with, taken from the
    # roster the `game:start` already gave us — a terran base and a zerg base
    # are different buildings, and hardcoding one of them would make this
    # assertion quietly wrong for the other player.
    start_a["players"].each do |seat|
      player_id = seat["player_id"]
      race = seat["race"]
      mine = entities_of(opening, player_id: player_id)
      expect(mine).not_to be_empty, "player #{player_id} owns nothing at match start"

      main_building = Starc::GameData.starting_building(race)
      worker = Starc::GameData.starting_unit(race)

      buildings = mine.select { |e| e["ty"] == main_building }
      workers = mine.select { |e| e["ty"] == worker }
      expect(buildings.size).to eq(1),
                                 "player #{player_id} (#{race}) should open with one #{main_building}, " \
                                 "got #{mine.map { |e| e['ty'] }.tally}"
      expect(workers.size).to be >= 1,
                                  "player #{player_id} (#{race}) opened with no #{worker}s"
    end
    expect_entity_heights!(entities)

    # The two players start apart, not stacked on one base.
    hq_a = entities_of(opening, player_id: @player_a[:id]).find { |e| e["ty"] == "command_center" }
    hq_b = entities_of(opening, player_id: @player_b[:id]).find { |e| e["ty"] == "hatchery" }
    expect(Math.hypot(hq_a["x"] - hq_b["x"], hq_a["z"] - hq_b["z"])).to be > 10,
                                                                             "both players opened on the same spot"

    # --- 4. commands flow, and one produces a new entity (PROTOCOL §4) ------
    # An scv costs exactly the 50 minerals a player opens with, and the
    # command_center that trains it is the building they opened with, so the
    # command is affordable on tick one — no waiting on the economy, which
    # matters because the suite has a wall-clock budget.
    #
    # Acceptance is observed as the command_center switching to `st ==
    # "training"`, not as a queued count. `Systems::Production` moves the
    # in-progress unit out of `train_queue` into `train_key` on the next tick,
    # so a batch of one leaves `n` at 0 (and omitted) almost immediately — `n`
    # is the *pending* count, not the total. `st` is the durable fact.
    before_ids = entities_of(await_snapshot(@player_a[:client]), player_id: @player_a[:id]).map { |e| e["id"] }

    send_commands(@player_a, [{ "c" => "train", "building_id" => hq_a["id"], "unit_type" => "scv", "count" => 1 }])

    training = wait_until("player A's command_center to start training", timeout: COMMAND_TIMEOUT) do
      snapshot = await_snapshot(@player_a[:client], quiet: true)
      next nil if snapshot.nil?

      entities_of(snapshot, player_id: @player_a[:id]).find { |e| e["id"] == hq_a["id"] && e["st"] == "training" }
    end
    expect(training).not_to be_nil, "the train command was never accepted by the command_center"

    # The scv itself is spawned when its build timer expires — 17 s of
    # simulation time, which is why this wait is bounded separately from the
    # one above. It is the end-to-end proof that the command reached the
    # simulation and not merely the command queue.
    trained = wait_until("a new scv to appear for player A", timeout: BUILD_COMPLETE_TIMEOUT) do
      snapshot = await_snapshot(@player_a[:client], quiet: true)
      next nil if snapshot.nil?

      entities_of(snapshot, player_id: @player_a[:id]).find { |e| !before_ids.include?(e["id"]) }
    end
    expect(trained).not_to be_nil, "the accepted train produced no new unit"
    expect(trained["ty"]).to eq("scv")

    # --- 5. a mixed batch rejects per command, by original index (PROTOCOL §4) -
    victim = entities_of(await_snapshot(@player_a[:client]), player_id: @player_a[:id])
                       .find { |e| e["ty"] == "scv" }
    before_move = entities_of(await_snapshot(@player_a[:client]), player_id: @player_a[:id])
                       .find { |e| e["id"] == victim["id"] }

    move_target = { "x" => before_move["x"] + 3.0, "z" => before_move["z"] }
    batch = [
      { "c" => "move", "ids" => [victim["id"]], "x" => move_target["x"], "z" => move_target["z"], "queue" => false },
      { "c" => "definitely_not_a_command", "ids" => [victim["id"]] },
      { "c" => "move", "ids" => Array.new(300) { |i| 900_000 + i }, "x" => 40.0, "z" => 40.0 }
    ]
    send_commands(@player_a, batch)

    reject = await_type(@player_a[:client], "game:reject", timeout: COMMAND_TIMEOUT,
                                                          description: "game:reject for the mixed batch").first
    rejected = reject.payload["rejected"]
    expect(rejected).to be_an(Array)

    # Indices must refer to the batch the client sent, not to the surviving
    # sub-batch after screening.
    bad_indices = rejected.map { |r| r["index"] }.sort
    expect(bad_indices).to eq([1, 2]),
                           "expected rejections at the original batch indices 1 and 2, got #{rejected.inspect}"
    expect(bad_indices).not_to include(0),
                                "the valid move at index 0 must not be rejected: #{rejected.inspect}"
    rejected.each do |entry|
      expect(entry["code"]).to be_a(String)
      expect(entry["code"]).to be_in(Starc::Sim::CommandResult::CODES)
    end

    # The valid command still took effect: the unit starts moving.
    wait_until("the valid move in the mixed batch to be applied", timeout: COMMAND_TIMEOUT) do
      snapshot = await_snapshot(@player_a[:client], quiet: true)
      next false if snapshot.nil?

      entity = entities_of(snapshot).find { |e| e["id"] == victim["id"] }
      entity && entity["st"] == "moving"
    end

    # --- 6. the match ends and both clients are told (PROTOCOL §5) -----------
    # A forfeit is the one ending a client can force deterministically, and it
    # still goes through the world, the results, the replay and the broadcast.
    forfeit = { "v" => 1, "t" => "game:forfeit" }
    @player_a[:client].send_message({ channel: "GameChannel", match_id: @match_id }, forfeit)

    ended_a = await_type(@player_a[:client], "game:ended", timeout: END_TIMEOUT,
                                                       description: "game:ended for the forfeiting client")
    ended_b = await_type(@player_b[:client], "game:ended", timeout: END_TIMEOUT,
                                                       description: "game:ended for the other client")

    [@player_a, @player_b].each_with_index do |_player, index|
      payload = [ended_a, ended_b][index].first.payload
      log = "\n--- e2e server log ---\n#{E2eServer.log_tail}"

      expect(payload["winner"]).to eq(@player_b[:id]), "forfeiter must lose#{log}"
      expect(payload["reason"]).to eq("forfeit"), "end reason#{log}"
      expect(payload["duration_ms"]).to be_a(Integer), "duration_ms#{log}"
      expect(payload["duration_ms"]).to be >= 0, "duration_ms must not be negative#{log}"
      expect(payload["tick"]).to be_a(Integer), "ended tick#{log}"
      expect(payload["replay_url"]).to eq("/api/v1/matches/#{@match_id}/replay")

      scores = payload["scores"]
      expect(scores).to be_an(Array), "scores#{log}"
      expect(scores.size).to eq(2), "scores must carry a row per player#{log}"
      score_ids = scores.map { |s| s["player_id"] }
      expect(score_ids).to contain_exactly(@player_a[:id], @player_b[:id])
      expect(scores.find { |s| s["player_id"] == @player_b[:id] }["result"]).to eq("win")
      expect(scores.find { |s| s["player_id"] == @player_a[:id] }["result"]).to eq("loss")
      scores.each do |score|
        expect(score).to include("race" => be_a(String), "kills" => be_an(Integer),
                                 "deaths" => be_an(Integer), "resources_mined" => be_an(Integer),
                                 "units_built" => be_an(Integer), "army_value" => be_an(Integer))
      end
    end

    ended_payload = ended_a.first.payload
    @replay_url = ended_payload["replay_url"]

    # --- 7. the replay_url already resolves (PROTOCOL §7/§8) -----------------
    # The replay is written before `game:ended` is broadcast, so by the time a
    # client holds the URL the row must be there. Fetching it is the assertion.
    status, replay = http_json(:get, @replay_url)
    expect(status).to eq(200), "replay_url #{@replay_url} answered #{status}: #{replay.inspect}\n#{E2eServer.log_tail}"

    expect(replay).to be_a(Hash)
    expect(replay["header"]).to be_a(Hash), "replay header#{E2eServer.log_tail}"
    header = replay["header"]
    expect(header["match_id"]).to eq(@match_id)
    expect(header["map_id"]).to eq("altaior")
    expect(header["seed"]).to eq(start_a["seed"])
    expect(header["winner"]).to eq(@player_b[:id])
    expect(header["players"]).to be_an(Array).and have_attributes(size: 2)

    # `commands` is the accepted command stream and nothing else. A command the
    # world refused never happened, so recording it would break the
    # determinism guarantee of PROTOCOL.md §8 — the `train` and the valid
    # `move` from the mixed batch must be here, and the two rejected commands
    # must not be.
    commands = replay["commands"]
    expect(commands).to be_an(Array), "replay commands must be an array, got #{commands.class}"
    expect(commands).not_to be_empty, "the replay recorded no commands at all"
    commands.each do |entry|
      expect(entry).to include("tick" => be_an(Integer), "player_id" => be_an(Integer), "index" => be_an(Integer))
      expect(entry["c"]).to be_a(String)
      expect(entry["player_id"]).to eq(@player_a[:id]), "only player A issued gameplay commands in this match"
    end

    recorded_types = commands.map { |c| c["c"] }.uniq
    expect(recorded_types).to include("train"), "the accepted train is missing from the replay"
    expect(recorded_types).to include("move"), "the accepted move from the mixed batch is missing"
    expect(recorded_types).not_to include("definitely_not_a_command"),
                                    "a rejected command was written to the replay: #{commands.inspect}"

    final_state = replay["final_state"]
    expect(final_state).to be_a(Hash), "replay final_state#{E2eServer.log_tail}"
    expect(final_state["entities"]).to be_an(Array)
    expect(final_state["entities"]).not_to be_empty, "the replay's final_state carries no entities"

    # The full replay document, which carries `format` and `version`.
    file_status, full = http_json(:get, "/api/v1/matches/#{@match_id}/replay_file")
    expect(file_status).to eq(200)
    expect(full["format"]).to eq("starc-replay")
    expect(full["version"]).to eq(1)
    expect(full["final_state"]).to be_a(Hash)

    # --- 8. the database agrees with the wire --------------------------------
    match = Match.find(@match_id)
    expect(match).to be_finished
    expect(match.winner_player_id).to eq(@player_b[:id])
    expect(match.end_reason).to eq("forfeit")
    expect(match.ended_at).to be_present

    seats = match.players_ordered
    expect(seats.size).to eq(2)
    expect(seats.find { |s| s.player_id == @player_b[:id] }.result).to eq("win")
    expect(seats.find { |s| s.player_id == @player_a[:id] }.result).to eq("loss")

    expect(Replay.where(match_id: @match_id).count).to eq(1),
                                               "exactly one replay row must exist for the match"

    expect(Player.find(@player_b[:id]).wins).to eq(1), "the winner's career wins moved"
    expect(Player.find(@player_a[:id]).losses).to eq(1), "the loser's career losses moved"
  end

  it "refuses a command from a client that never identified, and recovers afterwards" do
    start_match!

    expect_game_start!(@player_a[:client])

    # A third cable that is *anonymous at the socket* and never `identify`s on
    # the game channel. PROTOCOL.md §1 makes `identify` mandatory before any
    # other message, so a command from it must be refused. It opens without a
    # token deliberately: a connection that already carries a token satisfies
    # `require_player` on its own, so a token-carrying socket would exercise
    # that fallback rather than the refusal.
    bystander = open_cable({ name: "bystander", id: nil, token: nil }, "Bystander")
    game_params = { channel: "GameChannel", match_id: @match_id }
    bystander.subscribe(game_params)

    bystander.await_confirmation(CableClient.channel_key(game_params), timeout: CONNECT_TIMEOUT)
    bystander.send_message(game_params, { "v" => 1, "t" => "game:command", "id" => SecureRandom.uuid,
                                          "from_tick" => 0,
                                          "commands" => [{ "c" => "move", "ids" => [1], "x" => 40.0, "z" => 40.0 }] })

    error = await_type(bystander, "error", timeout: COMMAND_TIMEOUT,
                                             description: "a fatal unauthenticated error for the unidentified client")
    payload = error.first.payload
    expect(payload["code"]).to eq("unauthenticated")
    expect(payload["fatal"]).to be(true)

    # The refusal must end the exchange, not poison the subscription: the same
    # socket has to be able to identify and carry on. It identifies as player
    # A, who really is in this match.
    bystander.send_message(game_params, { "v" => 1, "t" => "identify", "token" => @player_a[:token] })
    expect_game_start!(bystander)

    worker = entities_of(await_snapshot(@player_a[:client]), player_id: @player_a[:id])
                    .find { |e| e["ty"] == "scv" }
    bystander.send_message(game_params, { "v" => 1, "t" => "game:command", "id" => SecureRandom.uuid,
                                          "from_tick" => 0,
                                          "commands" => [{ "c" => "select", "ids" => [worker["id"]] }] })

    # A `select` is accepted silently, so the proof it landed is that no second
    # `error` follows and the subscription still streams.
    late_error = bystander.drain(timeout: 1.0, type: "error")
    expect(late_error).to be_empty, "the recovered client was refused again: #{late_error.map(&:payload)}"
    expect(bystander.server_closed?).to be(false), "the cable was closed after the recovered command"
    expect(collect_snapshots(bystander, 2)).not_to be_empty
  end

  it "resyncs a late subscriber: its own game:start, then live snapshots" do
    start_match!

    expect_game_start!(@player_a[:client])
    first = collect_snapshots(@player_a[:client], 5)
    expect(first).not_to be_empty

    # A client that subscribes to a match already in progress is a reconnect.
    # PROTOCOL.md §3 and GameChannel both promise it its own `game:start` —
    # the opening state is rebuilt from seed + map + roster — followed by live
    # snapshots, so it can catch up instead of hanging on a stream it missed.
    latecomer = open_cable({ name: "latecomer", id: @player_a[:id], token: @player_a[:token] }, "Latecomer")
    game_params = { channel: "GameChannel", match_id: @match_id }
    latecomer.subscribe(game_params)
    latecomer.await_confirmation(CableClient.channel_key(game_params), timeout: CONNECT_TIMEOUT)
    latecomer.send_message(game_params, { "v" => 1, "t" => "identify", "token" => @player_a[:token] })

    start = expect_game_start!(latecomer)
    expect(start["match_id"]).to eq(@match_id)

    snapshots = collect_snapshots(latecomer, 5)
    expect(snapshots).not_to be_empty
    expect_snapshot_cadence!(snapshots)

    # Its first snapshot must be current, not a replay of tick 0: a resync that
    # hands back the opening state forever is the failure this guards.
    expect(snapshots.first["tick"]).to be > first.first["tick"],
                                      "the late subscriber resumed at tick #{snapshots.first['tick']}, " \
                                      "which is not ahead of #{first.first['tick']}"
  end

  # Returns the next snapshot payload, or nil when `quiet` is set and none
  # arrives inside the poll window.
  def await_snapshot(client, timeout: 5, quiet: false)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      return nil if remaining <= 0

      begin
        delivery = client.messages(timeout: [remaining, 0.2].min,
                                   description: "the next game:snapshot")
      rescue WebSocketClient::TimeoutError
        return nil if quiet

        next
      end

      payload = delivery.payload
      next unless payload["t"] == "game:snapshot"

      @last_tick = payload["tick"].to_i
      return payload
    end
  end
end
