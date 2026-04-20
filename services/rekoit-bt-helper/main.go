package main

import (
	"crypto/aes"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

func main() {
	if len(os.Args) < 4 {
		fmt.Println("Usage: rekoit-bt-helper resolve-rpa <IRK> <MAC>")
		os.Exit(2)
	}

	cmd := os.Args[1]
	if cmd != "resolve-rpa" {
		fmt.Printf("Unknown command: %s\n", cmd)
		os.Exit(2)
	}

	irkHex := os.Args[2]
	macAddr := os.Args[3]

	if err := resolveRPA(irkHex, macAddr); err != nil {
		// Match failed
		os.Exit(1)
	}
	// Match success
	os.Exit(0)
}

func resolveRPA(irkHex, macAddr string) error {
	irk, err := hex.DecodeString(irkHex)
	if err != nil {
		return fmt.Errorf("invalid IRK hex: %v", err)
	}
	if len(irk) != 16 {
		return fmt.Errorf("IRK must be 16 bytes")
	}

	// MAC format AA:BB:CC:DD:EE:FF
	parts := strings.Split(macAddr, ":")
	if len(parts) != 6 {
		return fmt.Errorf("invalid MAC address format")
	}

	var macBytes [6]byte
	for i := 0; i < 6; i++ {
		b, err := hex.DecodeString(parts[i])
		if err != nil || len(b) != 1 {
			return fmt.Errorf("invalid MAC byte: %s", parts[i])
		}
		macBytes[i] = b[0]
	}

	// RPA structure (Big Endian Display): 
	// prand: macBytes[0], macBytes[1], macBytes[2]  (MSB is macBytes[0])
	// hash:  macBytes[3], macBytes[4], macBytes[5]  (LSB is macBytes[5])
	
	// Bluetooth LE ah(k, r) function:
	// ah(k, r) = e(k, r') mod 2^24
	// r' is 128-bit padded version of 24-bit prand.
	// In Little-Endian (LE) byte array for AES:
	// rPrime[0...2] = prand_bytes (LSB first)
	// rPrime[3...15] = 0
	
	var rPrime [16]byte
	rPrime[0] = macBytes[2]
	rPrime[1] = macBytes[1]
	rPrime[2] = macBytes[0]

	cipher, err := aes.NewCipher(irk)
	if err != nil {
		return err
	}

	var output [16]byte
	cipher.Encrypt(output[:], rPrime[:])

	// The hash is the lowest 24 bits of the output.
	// In LE, this corresponds to the first 3 bytes of the block.
	// We compare them with the hash part of the MAC address.
	// Since MAC is displayed MSB first, our hash bytes are macBytes[3...5].
	// In LE, these are macBytes[5], macBytes[4], macBytes[3].
	
	if output[0] == macBytes[5] && output[1] == macBytes[4] && output[2] == macBytes[3] {
		return nil
	}

	return fmt.Errorf("hash mismatch")
}
