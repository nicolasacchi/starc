# frozen_string_literal: true

require "rails_helper"

# `lobby:state` is broadcast to every lobby subscriber, on every state change,
# and `lobby:create` has no rate limit — so its cost is whatever the server
# chooses to make it. It used to be `Match.all.select { … }.map(&:to_summary_hash)`:
# an unfiltered read of the whole table, then a COUNT plus two queries for the
# host per match, so one `lobby:state` over six matches cost nineteen statements
# and grew with every match the process had ever hosted.
RSpec.describe Starc::LobbyRegistry, "#matches" do
  subject(:registry) { described_class.instance }

  before do
    registry.invalidate!
  end

  after { registry.invalidate! }

  def seat(match, player, slot: 0, host: false)
    create(:match_player, match: match, player: player, slot: slot, host: host, race: "terran")
  end

  def count_statements
    queries = []
    subscriber = ActiveSupport::Notifications.subscribe("sql.active_record") do |*, payload|
      queries << payload[:sql] unless payload[:name].to_s == "SCHEMA"
    end
    yield
    queries
  ensure
    ActiveSupport::Notifications.unsubscribe(subscriber)
  end

  it "costs the same number of statements for six matches as for one" do
    one = create(:match, status: :lobby)
    seat(one, create(:player), host: true)
    registry.invalidate!
    for_one = count_statements { registry.matches }.size

    5.times do |n|
      room = create(:match, status: n.even? ? :lobby : :in_progress, started_at: Time.current)
      seat(room, create(:player), host: true)
    end
    registry.invalidate!
    for_six = count_statements { registry.matches }.size

    expect(for_six).to eq(for_one),
                        "the listing is still reading per match: #{for_one} statements for one, " \
                        "#{for_six} for six"
  end

  it "does not read matches a client cannot act on" do
    listed = create(:match, status: :lobby)
    create(:match, :finished, started_at: 1.hour.ago, ended_at: Time.current)
    create(:match, :abandoned, started_at: 1.hour.ago, ended_at: Time.current)
    seat(listed, create(:player), host: true)

    sql = count_statements { registry.matches }
    unfiltered = sql.select { |q| q.match?(/FROM "?matches"?/) && q !~ /WHERE/ }

    expect(unfiltered).to be_empty, "an unfiltered read of the matches table: #{unfiltered.inspect}"
  end

  it "caps how many matches one lobby:state can carry" do
    described_class::LIST_LIMIT.times do
      match = create(:match, status: :lobby)
      seat(match, create(:player), host: true)
    end
    create(:match, status: :lobby)

    expect(registry.matches.size).to eq(described_class::LIST_LIMIT)
  end

  it "lists the newest matches first, so the cap drops the oldest" do
    old = create(:match, status: :lobby, created_at: 2.days.ago)
    recent = create(:match, status: :lobby, created_at: 1.minute.ago)
    [old, recent].each { |m| seat(m, create(:player), host: true) }

    ids = registry.matches.map { |m| m[:id] }
    expect(ids.first).to eq(recent.id)
  end

  it "answers with exactly the shape the REST lobby uses for a match" do
    match = create(:match, status: :lobby, name: "Same Shape", max_players: 4)
    host = create(:player, name: "shapehost")
    seat(match, host, slot: 0, host: true)
    seat(match, create(:player), slot: 1)

    listed = registry.matches.find { |m| m[:id] == match.id }

    expect(listed).to eq(match.reload.to_summary_hash)
  end

  it "still reports the host, the seat count and the password flag from its own rows" do
    match = create(:match, status: :lobby, max_players: 4)
    host = create(:player, name: "listedhost")
    # The host is not the lowest slot here, so a summary that read the host off
    # seat order rather than the host flag would name the wrong player.
    seat(match, create(:player), slot: 0)
    create(:match_player, match: match, player: host, slot: 1, race: "zerg", host: true)
    match.update!(password_digest: BCrypt::Password.create("secret"))
    registry.invalidate!

    listed = registry.matches.find { |m| m[:id] == match.id }

    expect(listed[:player_count]).to eq(2)
    expect(listed[:host]).to eq("listedhost")
    expect(listed[:has_password]).to be(true)
  end

  it "keeps the filters working against the bounded listing" do
    melee = create(:match, status: :lobby, mode: "melee", name: "Melee Room")
    team = create(:match, status: :lobby, mode: "team", name: "Team Room")
    [melee, team].each { |m| seat(m, create(:player), host: true) }
    registry.invalidate!

    expect(registry.matches("mode" => "team").map { |m| m[:id] }).to eq([team.id])
    expect(registry.matches("mode" => "melee").map { |m| m[:id] }).to eq([melee.id])
  end
end
