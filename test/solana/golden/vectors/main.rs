use rally_solana_protocol::math::curve::*;
use rally_solana_protocol::math::liquidity::*;
use rally_solana_protocol::math::tick_math::*;
use rally_solana_protocol::state::presets::preset_segments;

fn main() {
    // tick -> sqrt
    let ticks = [-443636, -443635, -400000, -250000, -107640, -107427, -75360, -60, -1, 0, 1, 60, 61, 5000, 75360, 107640, 250000, 443580, 443635, 443636];
    for t in ticks { println!("SQRT {} {}", t, get_sqrt_price_at_tick(t).unwrap()); }
    // sqrt -> tick
    let sq: Vec<u128> = vec![4295048016, 4295048017, 100000000000, 18446744073709551616, 85764051471622491, 85710524338442141, 123456789012345678901234, 79226673521066979257578248090];
    for s in sq { println!("TICK {} {}", s, get_tick_at_sqrt_price(s).unwrap()); }
    // liquidity
    let a = get_sqrt_price_at_tick(-107640).unwrap();
    let b = get_sqrt_price_at_tick(-75360).unwrap();
    let p = get_sqrt_price_at_tick(-100000).unwrap();
    println!("L0 {}", liquidity_from_amount_0(a, b, 799861436269360).unwrap());
    println!("L1 {}", liquidity_from_amount_1(a, b, 85000000000).unwrap());
    for l in [4593921074891u128, 1u128, 98765432109u128] {
        for up in [false, true] {
            println!("D0 {} {} {}", l, up, amount_0_delta(a, b, l, up).unwrap());
            println!("D1 {} {} {}", l, up, amount_1_delta(a, b, l, up).unwrap());
            let r = amounts_for_liquidity(p, a, b, l, up).unwrap();
            println!("AFL {} {} {} {}", l, up, r.0, r.1);
        }
    }
    // curves
    for id in 0u8..3 {
        for (bn, b) in [("sol", 85_000_000_000u64), ("usdc", 15_000_000_000u64)] {
            let segs = preset_segments(id).unwrap();
            let l = build_curve(&segs, 1_000_000_000_000_000, 8000, b, 10000).unwrap();
            println!("CURVE {} {} {} {} {} {}", id, bn, l.tick_lower, l.tick_upper, l.curve_supply, l.tail_supply);
            for p in &l.positions { println!("POS {} {} {} {} {}", id, bn, p.tick_lower, p.tick_upper, p.liquidity); }
            for want in [0u64, 1, 1_000_000, 10_000_000_000_000, 80_000_000_000_000] {
                match sqrt_price_after_buy(&l.positions, l.tick_lower, want) {
                    Ok(s) => println!("BUY {} {} {} {}", id, bn, want, s),
                    Err(_) => println!("BUY {} {} {} ERR", id, bn, want),
                }
            }
        }
    }
}
