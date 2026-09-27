# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_09_27_000001) do
  create_table "leaderboard_entries", force: :cascade do |t|
    t.integer "player_id", null: false
    t.string "race"
    t.string "mode", default: "melee", null: false
    t.integer "wins", default: 0, null: false
    t.integer "losses", default: 0, null: false
    t.integer "draws", default: 0, null: false
    t.integer "rating", default: 1200, null: false
    t.integer "rank", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["mode", "rank"], name: "index_leaderboard_entries_on_mode_and_rank"
    t.index ["player_id", "mode"], name: "index_leaderboard_entries_on_player_id_and_mode", unique: true
    t.index ["rating"], name: "index_leaderboard_entries_on_rating"
  end

  create_table "match_players", force: :cascade do |t|
    t.integer "match_id", null: false
    t.integer "player_id", null: false
    t.integer "slot", null: false
    t.integer "team", default: 1, null: false
    t.string "race", null: false
    t.boolean "host", default: false, null: false
    t.boolean "ready", default: false, null: false
    t.integer "result", default: 0, null: false
    t.integer "kills", default: 0, null: false
    t.integer "deaths", default: 0, null: false
    t.decimal "resources_mined", precision: 16, default: "0", null: false
    t.integer "units_built", default: 0, null: false
    t.integer "army_value", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["match_id", "player_id"], name: "index_match_players_on_match_id_and_player_id", unique: true
    t.index ["match_id", "slot"], name: "index_match_players_on_match_id_and_slot", unique: true
  end

  create_table "matches", force: :cascade do |t|
    t.string "name", null: false
    t.string "mode", default: "melee", null: false
    t.string "map_id", null: false
    t.integer "max_players", default: 2, null: false
    t.integer "seed", null: false
    t.string "password_digest"
    t.integer "status", default: 0, null: false
    t.integer "winner_player_id"
    t.string "end_reason"
    t.integer "duration_ms"
    t.datetime "started_at"
    t.datetime "ended_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["status", "mode", "map_id"], name: "index_matches_on_status_and_mode_and_map_id"
    t.index ["status"], name: "index_matches_on_status"
  end

  create_table "players", force: :cascade do |t|
    t.string "name", null: false
    t.string "password_digest", null: false
    t.integer "wins", default: 0, null: false
    t.integer "losses", default: 0, null: false
    t.integer "draws", default: 0, null: false
    t.integer "kills", default: 0, null: false
    t.integer "deaths", default: 0, null: false
    t.decimal "resources_mined", precision: 16, default: "0", null: false
    t.integer "units_built", default: 0, null: false
    t.string "last_race"
    t.string "last_ip"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["name"], name: "index_players_on_name", unique: true
  end

  create_table "replays", force: :cascade do |t|
    t.integer "match_id", null: false
    t.integer "version", default: 1, null: false
    t.integer "format", default: 1, null: false
    t.text "header", null: false
    t.text "commands", null: false
    t.text "final_state", null: false
    t.integer "command_count", default: 0, null: false
    t.integer "tick_count", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["match_id"], name: "index_replays_on_match_id", unique: true
  end

  create_table "sessions", force: :cascade do |t|
    t.integer "player_id", null: false
    t.string "token", null: false
    t.datetime "expires_at", null: false
    t.string "last_ip"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["expires_at"], name: "index_sessions_on_expires_at"
    t.index ["token"], name: "index_sessions_on_token", unique: true
  end

  add_foreign_key "leaderboard_entries", "players"
  add_foreign_key "match_players", "matches"
  add_foreign_key "match_players", "players"
  add_foreign_key "replays", "matches"
  add_foreign_key "sessions", "players"
end
