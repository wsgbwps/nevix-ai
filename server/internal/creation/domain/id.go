package domain

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
)

// UUID is a domain identity value: a raw RFC 4122 v4 identifier exchanged
// with PostgreSQL's uuid columns and rendered externally in canonical
// lowercase form. It is deliberately the smallest self-contained shape so
// no external dependency enters the Module for ids.
type UUID [16]byte

var ErrInvalidUUID = errors.New("invalid uuid")

// NewUUID mints a random version-4 UUID. CSPRNG failure surfaces loudly:
// materializing identities without entropy would corrupt the keyset order.
func NewUUID() UUID {
	var u UUID
	if _, err := rand.Read(u[:]); err != nil {
		panic("creation: mint uuid without entropy: " + err.Error())
	}
	u[6] = (u[6] & 0x0f) | 0x40
	u[8] = (u[8] & 0x3f) | 0x80
	return u
}

// ParseUUID parses one canonical lowercase-hyphenated UUID string.
func ParseUUID(raw string) (UUID, error) {
	var u UUID
	if len(raw) != 36 {
		return u, ErrInvalidUUID
	}
	for _, p := range [4]int{8, 13, 18, 23} {
		if raw[p] != '-' {
			return u, ErrInvalidUUID
		}
	}
	hexed := raw[0:8] + raw[9:13] + raw[14:18] + raw[19:23] + raw[24:]
	blob, err := hex.DecodeString(hexed)
	if err != nil {
		return u, ErrInvalidUUID
	}
	copy(u[:], blob)
	return u, nil
}

func (u UUID) String() string {
	buf := make([]byte, 36)
	hex.Encode(buf[0:8], u[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], u[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], u[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], u[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], u[10:16])
	return string(buf)
}

// IsZero reports whether the id was never assigned.
func (u UUID) IsZero() bool {
	for _, b := range u {
		if b != 0 {
			return false
		}
	}
	return true
}
