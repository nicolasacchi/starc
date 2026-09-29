# frozen_string_literal: true

# Development seed data: a few accounts with plausible history so the
# leaderboard and player-stats endpoints have something real to render.
#
#   bin/rails db:seed
#
# These are demo accounts, all with the password "starcraft", plus fabricated
# leaderboard history. In production that is a liability, so seeding there
# requires an explicit opt-in:
#
#   STARC_SEED_DEMO=1 bin/rails db:seed

if Rails.env.production? && ENV["STARC_SEED_DEMO"].to_s.empty?
  abort "Refusing to seed demo accounts in production. " \
        "Set STARC_SEED_DEMO=1 to seed anyway (all accounts share the password \"starcraft\")."
end

SEED_PLAYERS = [
  { name: "nik",      password: "starcraft", race: "terran",  wins: 42, losses: 17, draws: 3, kills: 1284, deaths: 903, resources_mined: 412_500, units_built: 1102 },
  { name: "mvp",      password: "starcraft", race: "protoss", wins: 88, losses: 21, draws: 5, kills: 3102, deaths: 1401, resources_mined: 980_240, units_built: 2610 },
  { name: "zergling", password: "starcraft", race: "zerg",    wins: 61, losses: 29, draws: 2, kills: 2050, deaths: 1602, resources_mined: 733_100, units_built: 1888 },
  { name: "rushmore", password: "starcraft", race: "terran",  wins: 30, losses: 40, draws: 8, kills: 940,  deaths: 1204, resources_mined: 301_220, units_built: 940 },
  { name: "photon",   password: "starcraft", race: "protoss", wins: 12, losses: 55, draws: 1, kills: 402,  deaths: 1301, resources_mined: 142_600, units_built: 402 }
].freeze

ActiveRecord::Base.transaction do
  SEED_PLAYERS.each do |attrs|
    player = Player.find_or_initialize_by(name: attrs[:name])
    player.password = attrs[:password]
    player.password_confirmation = attrs[:password]
    player.assign_attributes(
      wins: attrs[:wins], losses: attrs[:losses], draws: attrs[:draws],
      kills: attrs[:kills], deaths: attrs[:deaths],
      resources_mined: attrs[:resources_mined], units_built: attrs[:units_built],
      last_race: attrs[:race]
    )
    player.save!
    player.issue_session!(ip: "127.0.0.1")

    # Seed the aggregate counters directly: replaying N `record!` calls would
    # only move the ELO rating, leaving wins/losses disagreeing with the player
    # row they came from.
    entry = LeaderboardEntry.for(player, mode: "melee")
    entry.race = attrs[:race]
    entry.wins = attrs[:wins]
    entry.losses = attrs[:losses]
    entry.draws = attrs[:draws]
    entry.rating = player.rating
    entry.save!
  end
end

puts "Seeded #{Player.count} players (password: \"starcraft\") and #{LeaderboardEntry.count} leaderboard entries."
