# frozen_string_literal: true

module Starc
  module Sim
    # An in-flight weapon shot. Pure data: the combat system advances it and
    # the damage system applies the effect when it lands.
    class Projectile
      # Aimed at an entity: it homes on the target's current position.
      # Aimed at a point: it flies to a fixed (tx, ty) and expires there.
      attr_accessor :id, :owner_id, :weapon, :x, :y, :z, :tx, :ty, :tz,
                    :target_id, :speed, :damage, :splash_radius, :splash_pct,
                    :expired, :created_tick

      def initialize(id:, owner_id:, weapon:, x:, y:, z:, tx:, ty:, tz:,
                     target_id: nil, speed:, damage:, splash_radius: nil, splash_pct: nil)
        @id = id
        @owner_id = owner_id
        @weapon = weapon
        @x = x
        @y = y
        @z = z
        @tx = tx
        @ty = ty
        @tz = tz
        @target_id = target_id
        @speed = speed
        @damage = damage
        @splash_radius = splash_radius
        @splash_pct = splash_pct
        @expired = false
        @created_tick = 0
      end

      def splash?
        !@splash_radius.nil? && @splash_radius.positive? && !@splash_pct.nil?
      end

      def distance_to(x, y)
        dx = x - @x
        dy = y - @y
        Math.sqrt((dx * dx) + (dy * dy))
      end

      def advance(dx, dy, dz)
        @x += dx
        @y += dy
        @z += dz
      end

      def arrive(tx, ty, tz)
        @x = tx
        @y = ty
        @z = tz
        @tx = tx
        @ty = ty
        @tz = tz
      end

      def to_event_hash
        {
          # `pk` is the weapon kind, so `ty` can stay the target height and
          # `tz` the target ground axis, matching `shot`.
          "e" => "proj", "id" => @id, "pk" => @weapon,
          "x" => round3(@x), "z" => round3(@y), "y" => round3(@z),
          "tx" => round3(@tx), "tz" => round3(@ty), "ty" => round3(@tz)
        }
      end

      def to_state_hash
        {
          "id" => @id, "owner_id" => @owner_id, "weapon" => @weapon,
          "x" => @x, "y" => @y, "z" => @z, "tx" => @tx, "ty" => @ty, "tz" => @tz,
          "target_id" => @target_id, "speed" => @speed, "damage" => @damage,
          "splash_radius" => @splash_radius, "splash_pct" => @splash_pct
        }
      end

      private

      def round3(v)
        (v * 1000.0).round / 1000.0
      end
    end
  end
end
