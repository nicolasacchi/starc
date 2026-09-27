class CreateStarcTables < ActiveRecord::Migration[8.1]
  def change
    create_table :players do |t|
      t.string  :name,     null: false
      t.string  :password_digest, null: false
      t.integer :wins,     null: false, default: 0
      t.integer :losses,   null: false, default: 0
      t.integer :draws,    null: false, default: 0
      t.integer :kills,    null: false, default: 0
      t.integer :deaths,   null: false, default: 0
      t.decimal :resources_mined, null: false, precision: 16, scale: 0, default: 0
      t.integer :units_built, null: false, default: 0
      t.string  :last_race
      t.string  :last_ip
      t.timestamps
    end
    add_index :players, :name, unique: true

    create_table :matches do |t|
      t.string  :name,     null: false
      t.string  :mode,     null: false, default: "melee"
      t.string  :map_id,   null: false
      t.integer :max_players, null: false, default: 2
      t.integer :seed,     null: false
      t.string  :password_digest
      t.integer :status,   null: false, default: 0
      t.integer :winner_player_id
      t.string  :end_reason
      t.integer :duration_ms
      t.datetime :started_at
      t.datetime :ended_at
      t.timestamps
    end
    add_index :matches, :status
    add_index :matches, %i[status mode map_id]

    create_table :match_players do |t|
      t.references :match,  null: false, foreign_key: true, index: false
      t.references :player, null: false, foreign_key: true, index: false
      t.integer :slot,   null: false
      t.integer :team,   null: false, default: 1
      t.string  :race,   null: false
      t.boolean :host,   null: false, default: false
      t.boolean :ready,  null: false, default: false
      t.integer :result,  null: false, default: 0
      t.integer :kills,   null: false, default: 0
      t.integer :deaths,  null: false, default: 0
      t.decimal :resources_mined, null: false, precision: 16, scale: 0, default: 0
      t.integer :units_built, null: false, default: 0
      t.integer :army_value, null: false, default: 0
      t.timestamps
    end
    add_index :match_players, %i[match_id player_id], unique: true
    add_index :match_players, %i[match_id slot], unique: true

    create_table :replays do |t|
      t.references :match, null: false, foreign_key: true, index: { unique: true }
      t.integer :version,  null: false, default: 1
      t.integer :format,   null: false, default: 1
      t.text    :header,   null: false
      t.text    :commands, null: false
      t.text    :final_state, null: false
      t.integer :command_count, null: false, default: 0
      t.integer :tick_count,   null: false, default: 0
      t.timestamps
    end

    create_table :leaderboard_entries do |t|
      t.references :player, null: false, foreign_key: true, index: false
      t.string  :race
      t.string  :mode, null: false, default: "melee"
      t.integer :wins,   null: false, default: 0
      t.integer :losses, null: false, default: 0
      t.integer :draws,  null: false, default: 0
      t.integer :rating, null: false, default: 1200
      t.integer :rank,   null: false, default: 0
      t.timestamps
    end
    add_index :leaderboard_entries, %i[player_id mode], unique: true
    add_index :leaderboard_entries, %i[mode rank]
    add_index :leaderboard_entries, :rating

    create_table :sessions do |t|
      t.references :player, null: false, foreign_key: true, index: false
      t.string :token, null: false
      t.datetime :expires_at, null: false
      t.string :last_ip
      t.timestamps
    end
    add_index :sessions, :token, unique: true
    add_index :sessions, :expires_at
  end
end
