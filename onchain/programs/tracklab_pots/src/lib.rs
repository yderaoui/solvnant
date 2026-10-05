//! TrackLab prize pots: entry pots + spectator bet pools for TrackLab races, in native SOL.
//!
//! TODO: security audit + legal review required before any real money / mainnet use.
//! This program is intended for Solana DEVNET / localnet only. It has NOT been audited, and
//! running real-money prize pools or wagering may be regulated (gambling / sweepstakes law)
//! in many jurisdictions.
//!
//! Flow
//! 1. `initialize_config` (once): sets the oracle/game-server authority, the treasury and fee_bps.
//! 2. `create_race`: authority commits to `seed_hash = sha256(seed)` before anyone pays in.
//! 3. `enter_race` / `place_bet`: players pay the entry fee, spectators bet on a slot, until
//!    `bets_close_ts`.
//! 4. `settle_race(seed, placings)`: authority reveals the seed (checked against the commitment)
//!    and the finishing order. The revealed seed is stored so anyone can re-run the deterministic
//!    sim off-chain and check the placings. Fees go to the treasury at this point.
//! 5. `claim_prize` / `claim_bet`: winners pull their share from the vault.
//! 6. `cancel_race` + `refund_entry` / `refund_bet`: full refunds if the race never settles.
//! 7. `close_race`: after every claim/refund (or after the claim window), sweeps the vault's
//!    leftover rounding dust + rent reserve to the treasury.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash as sha256;
use anchor_lang::system_program::{self, Transfer};

declare_id!("H452aBP2P7wuibVHcAZC36XV8obN85UAwwKTNvomygWe");

pub const CONFIG_SEED: &[u8] = b"config";
pub const RACE_SEED: &[u8] = b"race";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ENTRY_SEED: &[u8] = b"entry";
pub const BET_SEED: &[u8] = b"bet";

/// Fixed maximum grid size (also the size of the per-pick bet totals arrays).
pub const MAX_ENTRIES: usize = 10;
/// Maximum revealed seed length in bytes (the game uses string seeds; store their UTF-8 bytes).
pub const MAX_SEED_LEN: usize = 64;
/// fee_bps may not exceed 10%.
pub const MAX_FEE_BPS: u16 = 1_000;
pub const BPS_DENOM: u128 = 10_000;
/// Prize split of the entry pot for P1/P2/P3 (renormalised when fewer than 3 entrants).
pub const PRIZE_WEIGHTS: [u64; 3] = [60, 30, 10];

#[program]
pub mod tracklab_pots {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_bps: u16,
        treasury: Pubkey,
        settle_timeout_secs: i64,
        claim_window_secs: i64,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, PotsError::FeeTooHigh);
        require!(settle_timeout_secs > 0 && claim_window_secs > 0, PotsError::InvalidTimeout);
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = treasury;
        config.fee_bps = fee_bps;
        config.settle_timeout_secs = settle_timeout_secs;
        config.claim_window_secs = claim_window_secs;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_race(
        ctx: Context<CreateRace>,
        race_id: u64,
        seed_hash: [u8; 32],
        entry_fee: u64,
        bets_close_ts: i64,
        max_players: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            max_players >= 1 && (max_players as usize) <= MAX_ENTRIES,
            PotsError::InvalidMaxPlayers
        );
        require!(bets_close_ts > now, PotsError::CloseInPast);
        require!(seed_hash != [0u8; 32], PotsError::InvalidSeedHash);

        let config = &ctx.accounts.config;
        let settle_deadline_ts = bets_close_ts
            .checked_add(config.settle_timeout_secs)
            .ok_or(PotsError::MathOverflow)?;

        // Fund the vault with the rent-exempt minimum for a 0-byte system account, so it can
        // hold any amount without tripping the rent check. Swept to the treasury on close.
        let rent_reserve = Rent::get()?.minimum_balance(0);
        let vault_balance = ctx.accounts.vault.lamports();
        let top_up = rent_reserve.saturating_sub(vault_balance);
        if top_up > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                ),
                top_up,
            )?;
        }

        let race = &mut ctx.accounts.race;
        race.race_id = race_id;
        race.authority = config.authority;
        race.treasury = config.treasury;
        race.fee_bps = config.fee_bps;
        race.claim_window_secs = config.claim_window_secs;
        race.seed_hash = seed_hash;
        race.seed = [0u8; MAX_SEED_LEN];
        race.seed_len = 0;
        race.entry_fee = entry_fee;
        race.created_ts = now;
        race.bets_close_ts = bets_close_ts;
        race.settle_deadline_ts = settle_deadline_ts;
        race.finalized_ts = 0;
        race.claim_deadline_ts = 0;
        race.max_players = max_players;
        race.num_entries = 0;
        race.placings = [0u8; MAX_ENTRIES];
        race.entry_pot = 0;
        race.bet_total = 0;
        race.pick_totals = [0u64; MAX_ENTRIES];
        race.pick_counts = [0u32; MAX_ENTRIES];
        race.num_bets = 0;
        race.prize_pool = 0;
        race.bet_pool = 0;
        race.bets_refunded = false;
        race.pending_claims = 0;
        race.rent_reserve = rent_reserve;
        race.status = RaceStatus::Open;
        race.bump = ctx.bumps.race;
        race.vault_bump = ctx.bumps.vault;

        msg!("race {} created, entry_fee={} close={}", race_id, entry_fee, bets_close_ts);
        Ok(())
    }

    pub fn enter_race(ctx: Context<EnterRace>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Open, PotsError::RaceNotOpen);
        require!(now < race.bets_close_ts, PotsError::EntriesClosed);
        require!(race.num_entries < race.max_players, PotsError::RaceFull);

        let slot = race.num_entries;
        race.num_entries = slot.checked_add(1).ok_or(PotsError::MathOverflow)?;
        race.entry_pot = race
            .entry_pot
            .checked_add(race.entry_fee)
            .ok_or(PotsError::MathOverflow)?;

        let entry = &mut ctx.accounts.entry;
        entry.race = race.key();
        entry.player = ctx.accounts.player.key();
        entry.slot = slot;
        entry.claimed = false;
        entry.bump = ctx.bumps.entry;

        if race.entry_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.player.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                ),
                race.entry_fee,
            )?;
        }
        Ok(())
    }

    pub fn place_bet(ctx: Context<PlaceBet>, pick: u8, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Open, PotsError::RaceNotOpen);
        require!(now < race.bets_close_ts, PotsError::BettingClosed);
        require!(amount > 0, PotsError::ZeroAmount);
        require!(pick < race.num_entries, PotsError::InvalidPick);

        let p = pick as usize;
        race.pick_totals[p] = race.pick_totals[p]
            .checked_add(amount)
            .ok_or(PotsError::MathOverflow)?;
        race.pick_counts[p] = race.pick_counts[p]
            .checked_add(1)
            .ok_or(PotsError::MathOverflow)?;
        race.num_bets = race.num_bets.checked_add(1).ok_or(PotsError::MathOverflow)?;
        race.bet_total = race
            .bet_total
            .checked_add(amount)
            .ok_or(PotsError::MathOverflow)?;

        let bet = &mut ctx.accounts.bet;
        bet.race = race.key();
        bet.bettor = ctx.accounts.bettor.key();
        bet.pick = pick;
        bet.amount = amount;
        bet.claimed = false;
        bet.bump = ctx.bumps.bet;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bettor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    pub fn settle_race(ctx: Context<SettleRace>, seed: Vec<u8>, placings: Vec<u8>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let race_key = ctx.accounts.race.key();
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Open, PotsError::RaceNotOpen);
        require!(now >= race.bets_close_ts, PotsError::BettingStillOpen);

        // Commit-reveal: the revealed seed must hash to the commitment made at creation.
        require!(
            !seed.is_empty() && seed.len() <= MAX_SEED_LEN,
            PotsError::InvalidSeedLength
        );
        require!(sha256(&seed).to_bytes() == race.seed_hash, PotsError::SeedMismatch);

        // Placings: finishing order as entry slot indices, must be a permutation of 0..n.
        let n = race.num_entries as usize;
        require!(placings.len() == n, PotsError::InvalidPlacings);
        let mut seen: u32 = 0;
        for &slot in placings.iter() {
            require!((slot as usize) < n, PotsError::InvalidPlacings);
            let bit = 1u32 << slot;
            require!(seen & bit == 0, PotsError::InvalidPlacings);
            seen |= bit;
        }

        race.seed[..seed.len()].copy_from_slice(&seed);
        race.seed_len = seed.len() as u8;
        race.placings[..n].copy_from_slice(&placings);

        // Entry pot: fee to treasury, rest is the prize pool.
        let entry_cut = bps_of(race.entry_pot, race.fee_bps)?;
        race.prize_pool = race
            .entry_pot
            .checked_sub(entry_cut)
            .ok_or(PotsError::MathOverflow)?;
        let mut pending: u32 = (n.min(PRIZE_WEIGHTS.len())) as u32;

        // Bet pool: if somebody backed the winner, fee to treasury and pro-rata payout;
        // otherwise (incl. no entrants) every bet is refunded in full, no fee.
        let mut bet_cut: u64 = 0;
        if race.num_bets > 0 {
            let winner_backed = n > 0 && race.pick_totals[placings[0] as usize] > 0;
            if winner_backed {
                bet_cut = bps_of(race.bet_total, race.fee_bps)?;
                race.bet_pool = race
                    .bet_total
                    .checked_sub(bet_cut)
                    .ok_or(PotsError::MathOverflow)?;
                race.bets_refunded = false;
                pending = pending
                    .checked_add(race.pick_counts[placings[0] as usize])
                    .ok_or(PotsError::MathOverflow)?;
            } else {
                race.bet_pool = race.bet_total;
                race.bets_refunded = true;
                pending = pending
                    .checked_add(race.num_bets)
                    .ok_or(PotsError::MathOverflow)?;
            }
        }
        race.pending_claims = pending;
        race.finalized_ts = now;
        race.claim_deadline_ts = now
            .checked_add(race.claim_window_secs)
            .ok_or(PotsError::MathOverflow)?;
        race.status = RaceStatus::Settled;

        let total_cut = entry_cut.checked_add(bet_cut).ok_or(PotsError::MathOverflow)?;
        let reserve = race.rent_reserve;
        let vault_bump = race.vault_bump;
        pay_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.system_program,
            &race_key,
            vault_bump,
            total_cut,
            reserve,
        )?;
        msg!("race settled, fees={} pending_claims={}", total_cut, pending);
        Ok(())
    }

    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
        let race_key = ctx.accounts.race.key();
        let race = &mut ctx.accounts.race;
        let entry = &mut ctx.accounts.entry;
        require!(race.status == RaceStatus::Settled, PotsError::RaceNotSettled);
        require!(!entry.claimed, PotsError::AlreadyClaimed);

        let n = race.num_entries as usize;
        let pos = race.placings[..n]
            .iter()
            .position(|&s| s == entry.slot)
            .ok_or(PotsError::InvalidPlacings)?;
        let paid_places = n.min(PRIZE_WEIGHTS.len());
        require!(pos < paid_places, PotsError::NothingToClaim);

        let weight_sum: u64 = PRIZE_WEIGHTS[..paid_places].iter().sum();
        let payout = mul_div(race.prize_pool, PRIZE_WEIGHTS[pos], weight_sum)?;

        entry.claimed = true;
        race.pending_claims = race
            .pending_claims
            .checked_sub(1)
            .ok_or(PotsError::MathOverflow)?;
        let (reserve, vault_bump) = (race.rent_reserve, race.vault_bump);
        pay_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.player.to_account_info(),
            &ctx.accounts.system_program,
            &race_key,
            vault_bump,
            payout,
            reserve,
        )?;
        msg!("prize claimed: place={} payout={}", pos + 1, payout);
        Ok(())
    }

    pub fn claim_bet(ctx: Context<ClaimBet>) -> Result<()> {
        let race_key = ctx.accounts.race.key();
        let race = &mut ctx.accounts.race;
        let bet = &mut ctx.accounts.bet;
        require!(race.status == RaceStatus::Settled, PotsError::RaceNotSettled);
        require!(!bet.claimed, PotsError::AlreadyClaimed);

        let payout = if race.bets_refunded {
            bet.amount
        } else {
            let winner = race.placings[0];
            require!(bet.pick == winner, PotsError::NothingToClaim);
            mul_div(race.bet_pool, bet.amount, race.pick_totals[winner as usize])?
        };

        bet.claimed = true;
        race.pending_claims = race
            .pending_claims
            .checked_sub(1)
            .ok_or(PotsError::MathOverflow)?;
        let (reserve, vault_bump) = (race.rent_reserve, race.vault_bump);
        pay_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.bettor.to_account_info(),
            &ctx.accounts.system_program,
            &race_key,
            vault_bump,
            payout,
            reserve,
        )?;
        msg!("bet claimed: payout={}", payout);
        Ok(())
    }

    /// Authority can cancel any time before settlement. Anyone can cancel once the settle
    /// deadline (bets_close_ts + settle_timeout_secs) has passed without a settlement, so funds
    /// can't be stuck if the game server disappears.
    pub fn cancel_race(ctx: Context<CancelRace>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let race = &mut ctx.accounts.race;
        require!(race.status == RaceStatus::Open, PotsError::RaceNotOpen);
        let is_authority = ctx.accounts.caller.key() == race.authority;
        require!(
            is_authority || now > race.settle_deadline_ts,
            PotsError::Unauthorized
        );
        race.status = RaceStatus::Cancelled;
        race.pending_claims = (race.num_entries as u32)
            .checked_add(race.num_bets)
            .ok_or(PotsError::MathOverflow)?;
        race.finalized_ts = now;
        race.claim_deadline_ts = now
            .checked_add(race.claim_window_secs)
            .ok_or(PotsError::MathOverflow)?;
        msg!("race cancelled, pending refunds={}", race.pending_claims);
        Ok(())
    }

    pub fn refund_entry(ctx: Context<ClaimPrize>) -> Result<()> {
        let race_key = ctx.accounts.race.key();
        let race = &mut ctx.accounts.race;
        let entry = &mut ctx.accounts.entry;
        require!(race.status == RaceStatus::Cancelled, PotsError::RaceNotCancelled);
        require!(!entry.claimed, PotsError::AlreadyClaimed);
        entry.claimed = true;
        race.pending_claims = race
            .pending_claims
            .checked_sub(1)
            .ok_or(PotsError::MathOverflow)?;
        let (amount, reserve, vault_bump) = (race.entry_fee, race.rent_reserve, race.vault_bump);
        pay_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.player.to_account_info(),
            &ctx.accounts.system_program,
            &race_key,
            vault_bump,
            amount,
            reserve,
        )
    }

    pub fn refund_bet(ctx: Context<ClaimBet>) -> Result<()> {
        let race_key = ctx.accounts.race.key();
        let race = &mut ctx.accounts.race;
        let bet = &mut ctx.accounts.bet;
        require!(race.status == RaceStatus::Cancelled, PotsError::RaceNotCancelled);
        require!(!bet.claimed, PotsError::AlreadyClaimed);
        bet.claimed = true;
        race.pending_claims = race
            .pending_claims
            .checked_sub(1)
            .ok_or(PotsError::MathOverflow)?;
        let (amount, reserve, vault_bump) = (bet.amount, race.rent_reserve, race.vault_bump);
        pay_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.bettor.to_account_info(),
            &ctx.accounts.system_program,
            &race_key,
            vault_bump,
            amount,
            reserve,
        )
    }

    /// Permissionless crank: once every claim/refund is done (or the claim window expired),
    /// sweep everything left in the vault (rounding dust + rent reserve + unclaimed funds after
    /// the window) to the treasury. The Race account is kept so the revealed seed and placings
    /// stay publicly verifiable.
    pub fn close_race(ctx: Context<CloseRace>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let race_key = ctx.accounts.race.key();
        let race = &mut ctx.accounts.race;
        require!(
            race.status == RaceStatus::Settled || race.status == RaceStatus::Cancelled,
            PotsError::RaceNotFinalized
        );
        require!(
            race.pending_claims == 0 || now >= race.claim_deadline_ts,
            PotsError::ClaimsPending
        );
        race.status = RaceStatus::Closed;
        let sweep = ctx.accounts.vault.lamports();
        let vault_bump = race.vault_bump;
        pay_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.system_program,
            &race_key,
            vault_bump,
            sweep,
            0,
        )?;
        msg!("race closed, swept {} lamports to treasury", sweep);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// floor(amount * bps / 10_000), overflow-safe.
fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    mul_div(amount, bps as u64, BPS_DENOM as u64)
}

/// floor(a * b / c) in u128, overflow-safe. Flooring guarantees payouts never exceed the pool.
fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, PotsError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(PotsError::MathOverflow)?
        .checked_div(c as u128)
        .ok_or(PotsError::MathOverflow)?;
    u64::try_from(v).map_err(|_| error!(PotsError::MathOverflow))
}

/// Move lamports out of the system-owned vault PDA. Refuses to dip below `keep`, so rounding
/// errors can never overdraw the vault into other races' or the rent reserve's funds.
fn pay_from_vault<'info>(
    vault: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    race_key: &Pubkey,
    vault_bump: u8,
    amount: u64,
    keep: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let remaining = vault
        .lamports()
        .checked_sub(amount)
        .ok_or(PotsError::VaultInsufficient)?;
    require!(remaining >= keep, PotsError::VaultInsufficient);
    let bump = [vault_bump];
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, race_key.as_ref(), &bump];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: to.clone(),
            },
            &[signer_seeds],
        ),
        amount,
    )
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(race_id: u64)]
pub struct CreateRace<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ PotsError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + Race::INIT_SPACE,
        seeds = [RACE_SEED, race_id.to_le_bytes().as_ref()],
        bump
    )]
    pub race: Box<Account<'info, Race>>,
    #[account(mut, seeds = [VAULT_SEED, race.key().as_ref()], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnterRace<'info> {
    #[account(mut, seeds = [RACE_SEED, race.race_id.to_le_bytes().as_ref()], bump = race.bump)]
    pub race: Box<Account<'info, Race>>,
    #[account(mut, seeds = [VAULT_SEED, race.key().as_ref()], bump = race.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        init,
        payer = player,
        space = 8 + Entry::INIT_SPACE,
        seeds = [ENTRY_SEED, race.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub entry: Account<'info, Entry>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pick: u8)]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [RACE_SEED, race.race_id.to_le_bytes().as_ref()], bump = race.bump)]
    pub race: Box<Account<'info, Race>>,
    #[account(mut, seeds = [VAULT_SEED, race.key().as_ref()], bump = race.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        init,
        payer = bettor,
        space = 8 + Bet::INIT_SPACE,
        seeds = [BET_SEED, race.key().as_ref(), bettor.key().as_ref(), &[pick]],
        bump
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleRace<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ PotsError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [RACE_SEED, race.race_id.to_le_bytes().as_ref()],
        bump = race.bump,
        constraint = race.authority == authority.key() @ PotsError::Unauthorized
    )]
    pub race: Box<Account<'info, Race>>,
    #[account(mut, seeds = [VAULT_SEED, race.key().as_ref()], bump = race.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: only receives lamports; pinned to the treasury snapshotted on the race.
    #[account(mut, address = race.treasury @ PotsError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Shared by `claim_prize` and `refund_entry`.
#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut, seeds = [RACE_SEED, race.race_id.to_le_bytes().as_ref()], bump = race.bump)]
    pub race: Box<Account<'info, Race>>,
    #[account(mut, seeds = [VAULT_SEED, race.key().as_ref()], bump = race.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [ENTRY_SEED, race.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
        has_one = race,
        has_one = player
    )]
    pub entry: Account<'info, Entry>,
    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Shared by `claim_bet` and `refund_bet`.
#[derive(Accounts)]
pub struct ClaimBet<'info> {
    #[account(mut, seeds = [RACE_SEED, race.race_id.to_le_bytes().as_ref()], bump = race.bump)]
    pub race: Box<Account<'info, Race>>,
    #[account(mut, seeds = [VAULT_SEED, race.key().as_ref()], bump = race.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [BET_SEED, race.key().as_ref(), bettor.key().as_ref(), &[bet.pick]],
        bump = bet.bump,
        has_one = race,
        has_one = bettor
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRace<'info> {
    #[account(mut, seeds = [RACE_SEED, race.race_id.to_le_bytes().as_ref()], bump = race.bump)]
    pub race: Box<Account<'info, Race>>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseRace<'info> {
    #[account(mut, seeds = [RACE_SEED, race.race_id.to_le_bytes().as_ref()], bump = race.bump)]
    pub race: Box<Account<'info, Race>>,
    #[account(mut, seeds = [VAULT_SEED, race.key().as_ref()], bump = race.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: only receives lamports; pinned to the treasury snapshotted on the race.
    #[account(mut, address = race.treasury @ PotsError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Game server / oracle key: the only key allowed to create and settle races.
    pub authority: Pubkey,
    /// Receives fees, rounding dust and vault rent reserves. Must be a rent-exempt account.
    pub treasury: Pubkey,
    pub fee_bps: u16,
    /// After bets_close_ts + this, anyone may cancel an unsettled race (refunds open up).
    pub settle_timeout_secs: i64,
    /// After settle/cancel + this, anyone may close the race and sweep unclaimed funds.
    pub claim_window_secs: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RaceStatus {
    Open,
    Settled,
    Cancelled,
    Closed,
}

#[account]
#[derive(InitSpace)]
pub struct Race {
    pub race_id: u64,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub claim_window_secs: i64,
    /// sha256(seed), committed before anyone can enter or bet.
    pub seed_hash: [u8; 32],
    /// Revealed seed (first `seed_len` bytes), written at settlement.
    pub seed: [u8; MAX_SEED_LEN],
    pub seed_len: u8,
    pub entry_fee: u64,
    pub created_ts: i64,
    pub bets_close_ts: i64,
    pub settle_deadline_ts: i64,
    /// When the race was settled or cancelled.
    pub finalized_ts: i64,
    pub claim_deadline_ts: i64,
    pub max_players: u8,
    pub num_entries: u8,
    /// Finishing order as entry slot indices (first `num_entries` are meaningful).
    pub placings: [u8; MAX_ENTRIES],
    pub entry_pot: u64,
    pub bet_total: u64,
    pub pick_totals: [u64; MAX_ENTRIES],
    pub pick_counts: [u32; MAX_ENTRIES],
    pub num_bets: u32,
    /// Entry pot after fee (set at settle).
    pub prize_pool: u64,
    /// Bet pool after fee (set at settle; equals bet_total when bets are refunded).
    pub bet_pool: u64,
    /// True when nobody backed the winner: every bet is refunded in full.
    pub bets_refunded: bool,
    /// Claims/refunds still owed. close_race needs 0 (or the claim window to expire).
    pub pending_claims: u32,
    pub rent_reserve: u64,
    pub status: RaceStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub race: Pubkey,
    pub player: Pubkey,
    pub slot: u8,
    pub claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub race: Pubkey,
    pub bettor: Pubkey,
    pub pick: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[error_code]
pub enum PotsError {
    #[msg("fee_bps exceeds the 10% maximum")]
    FeeTooHigh,
    #[msg("timeouts must be positive")]
    InvalidTimeout,
    #[msg("signer is not the configured authority")]
    Unauthorized,
    #[msg("max_players must be between 1 and 10")]
    InvalidMaxPlayers,
    #[msg("bets_close_ts must be in the future")]
    CloseInPast,
    #[msg("seed_hash must be non-zero")]
    InvalidSeedHash,
    #[msg("race is not open")]
    RaceNotOpen,
    #[msg("entries are closed")]
    EntriesClosed,
    #[msg("race is full")]
    RaceFull,
    #[msg("betting is closed")]
    BettingClosed,
    #[msg("betting is still open")]
    BettingStillOpen,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("pick is not an entered slot")]
    InvalidPick,
    #[msg("seed must be 1..=64 bytes")]
    InvalidSeedLength,
    #[msg("sha256(seed) does not match the committed seed_hash")]
    SeedMismatch,
    #[msg("placings must be a permutation of the entered slots")]
    InvalidPlacings,
    #[msg("race is not settled")]
    RaceNotSettled,
    #[msg("race is not cancelled")]
    RaceNotCancelled,
    #[msg("race is neither settled nor cancelled")]
    RaceNotFinalized,
    #[msg("already claimed")]
    AlreadyClaimed,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("claims are still pending and the claim window is open")]
    ClaimsPending,
    #[msg("treasury account does not match")]
    InvalidTreasury,
    #[msg("vault balance would drop below its reserve")]
    VaultInsufficient,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
